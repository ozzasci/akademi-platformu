import React, { useState, useEffect, useRef } from "react";
import Peer from "peerjs";

// Yanlış Havuzu (Tarayıcı Hafızası) Fonksiyonları
const getErrors = () => JSON.parse(localStorage.getItem("errorPool") || "[]");
const saveError = (id) => {
  const errors = getErrors();
  if (!errors.includes(id))
    localStorage.setItem("errorPool", JSON.stringify([...errors, id]));
};
const removeError = (id) => {
  const errors = getErrors();
  localStorage.setItem(
    "errorPool",
    JSON.stringify(errors.filter((e) => e !== id))
  );
};

export default function App() {
  const [allQuestions, setAllQuestions] = useState([]);
  const [loading, setLoading] = useState(true);

  const [appState, setAppState] = useState("setup");
  const [selectedCourses, setSelectedCourses] = useState([]);
  const [questionCount, setQuestionCount] = useState(10);
  const [mode, setMode] = useState("exam"); // exam, study, versus, online_versus, errors
  const [darkMode, setDarkMode] = useState(true); // Varsayılan şık bir koyu tema

  const [quizQuestions, setQuizQuestions] = useState([]);
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState({});
  const [showHint, setShowHint] = useState(false);
  const [showAnswerNow, setShowAnswerNow] = useState(false);

  // Yarış & PeerJS State'leri
  const [playerScores, setPlayerScores] = useState({ 1: 0, 2: 0 });
  const [waitingNextTurn, setWaitingNextTurn] = useState(false);
  const peerRef = useRef(null);
  const connRef = useRef(null);
  const [myId, setMyId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [multiplayerStatus, setMultiplayerStatus] = useState("");

  const [totalTimeLeft, setTotalTimeLeft] = useState(0);
  const [questionTimeLeft, setQuestionTimeLeft] = useState(60);

  // Otomatik Veritabanı Çekme
  useEffect(() => {
    fetch("/questions.json")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setAllQuestions(data);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const jsonContent = JSON.parse(event.target.result);
        if (Array.isArray(jsonContent) && jsonContent.length > 0) {
          setAllQuestions(jsonContent);
          alert(`Başarıyla ${jsonContent.length} soru yüklendi!`);
        } else {
          alert("Yüklenen dosya geçerli bir soru listesi içermiyor!");
        }
      } catch (error) {
        alert("JSON dosyası okunurken hata oluştu!");
      }
    };
    reader.readAsText(file);
  };

  const availableCourses = [...new Set(allQuestions.map((q) => q.course))];
  const errorCount = getErrors().length;

  const activePlayerNum = currentQIndex % 2 === 0 ? 1 : 2;
  const isOnline = mode === "online_versus";
  const amIActive = isOnline
    ? isHost
      ? activePlayerNum === 1
      : activePlayerNum === 2
    : true;

  useEffect(() => {
    if (quizQuestions.length > 0 && currentQIndex >= quizQuestions.length) {
      setAppState("results");
    }
  }, [currentQIndex, quizQuestions.length]);

  // Zamanlayıcı
  useEffect(() => {
    let timer;
    if (appState === "quiz" && !showAnswerNow && !waitingNextTurn) {
      timer = setInterval(() => {
        if (mode === "exam") {
          setTotalTimeLeft((prev) => {
            if (prev <= 1) {
              setAppState("results");
              return 0;
            }
            return prev - 1;
          });
        }

        setQuestionTimeLeft((prev) => {
          if (prev <= 1) {
            if (mode === "study" || mode === "errors") {
              setShowAnswerNow(true);
              saveError(quizQuestions[currentQIndex]?.id);
              return 0;
            } else if (mode === "versus" || isOnline) {
              handleTimeout(currentQIndex);
              return 0;
            } else {
              handleNextQuestionLocal();
              return 60;
            }
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [appState, showAnswerNow, waitingNextTurn, mode, currentQIndex]);

  const initPeer = (asHost) => {
    if (peerRef.current) peerRef.current.destroy();
    const customId = asHost
      ? "ODA-" + Math.random().toString(36).substring(2, 6).toUpperCase()
      : undefined;
    const peer = new Peer(customId);
    peerRef.current = peer;

    peer.on("open", (id) => {
      setMyId(id);
      setIsHost(asHost);
      setMultiplayerStatus(asHost ? "hosting" : "ready_to_join");
    });

    peer.on("connection", (connection) => {
      connRef.current = connection;
      setMultiplayerStatus("connected");
      connection.on("data", handleRemoteData);
    });

    peer.on("error", (err) => alert("Bağlantı hatası: " + err.type));
  };

  const joinRoom = () => {
    if (!peerRef.current || !joinId) return alert("Lütfen oda kodu girin!");
    const connection = peerRef.current.connect(joinId.toUpperCase().trim());
    connRef.current = connection;
    connection.on("open", () => {
      setMultiplayerStatus("connected");
      setIsHost(false);
    });
    connection.on("error", () => alert("Odaya bağlanılamadı!"));
    connection.on("data", handleRemoteData);
  };

  const handleRemoteData = (data) => {
    if (data.type === "START") {
      setQuizQuestions(data.questions);
      setMode("online_versus");
      setAppState("quiz");
      setPlayerScores({ 1: 0, 2: 0 });
      setQuestionTimeLeft(15);
      setCurrentQIndex(0);
      setUserAnswers({});
      setShowAnswerNow(false);
      setWaitingNextTurn(false);
    } else if (data.type === "ANSWER") {
      processAnswer(data.answer, data.isCorrect, data.playerNum, data.qIndex);
    }
  };

  const toggleCourse = (course) => {
    setSelectedCourses((prev) =>
      prev.includes(course)
        ? prev.filter((c) => c !== course)
        : [...prev, course]
    );
  };

  const startQuiz = () => {
    if (allQuestions.length === 0)
      return alert("Soru veritabanı boş! Lütfen dosya yükleyin.");
    let filtered = [];
    if (mode === "errors") {
      const errorIds = getErrors();
      filtered = allQuestions.filter((q) => errorIds.includes(q.id));
      if (filtered.length === 0)
        return alert("Harika! Hafızada hiç yanlışınız yok.");
      filtered = filtered.sort(() => 0.5 - Math.random());
    } else {
      if (selectedCourses.length === 0)
        return alert("Lütfen en az bir ders seçin!");
      filtered = allQuestions.filter((q) => selectedCourses.includes(q.course));
      const qCount =
        mode === "versus" || mode === "online_versus" ? 20 : questionCount;
      filtered = filtered.sort(() => 0.5 - Math.random()).slice(0, qCount);
      if (filtered.length === 0)
        return alert("Seçilen derslerde yeterli soru yok!");
    }

    if (mode === "online_versus" && connRef.current) {
      connRef.current.send({ type: "START", questions: filtered });
    }

    setQuizQuestions(filtered);
    setAppState("quiz");
    setTotalTimeLeft(filtered.length * 2 * 60);
    setQuestionTimeLeft(
      mode === "versus" || mode === "online_versus" ? 15 : 60
    );
    setCurrentQIndex(0);
    setUserAnswers({});
    setShowHint(false);
    setShowAnswerNow(false);
    setPlayerScores({ 1: 0, 2: 0 });
    setWaitingNextTurn(false);
  };

  const processAnswer = (answer, isCorrect, playerNum, qIndex) => {
    setUserAnswers((prev) => ({ ...prev, [qIndex]: answer }));
    setShowAnswerNow(true);
    setWaitingNextTurn(true);
    if (isCorrect)
      setPlayerScores((prev) => ({
        ...prev,
        [playerNum]: prev[playerNum] + 1,
      }));
    setTimeout(() => {
      setCurrentQIndex((prev) => (prev === qIndex ? prev + 1 : prev));
      setQuestionTimeLeft(
        mode === "versus" || mode === "online_versus" ? 15 : 60
      );
      setShowHint(false);
      setShowAnswerNow(false);
      setWaitingNextTurn(false);
    }, 2500);
  };

  const handleTimeout = (qIndex) => {
    setShowAnswerNow(true);
    setWaitingNextTurn(true);
    saveError(quizQuestions[qIndex]?.id);
    setTimeout(() => {
      setCurrentQIndex((prev) => (prev === qIndex ? prev + 1 : prev));
      setQuestionTimeLeft(
        mode === "versus" || mode === "online_versus" ? 15 : 60
      );
      setShowHint(false);
      setShowAnswerNow(false);
      setWaitingNextTurn(false);
    }, 2500);
  };

  const handleAnswer = (answer) => {
    if (showAnswerNow || waitingNextTurn) return;
    const q = quizQuestions[currentQIndex];
    const isCorrect = answer === q.correctAnswer;

    if (isOnline) {
      if (!amIActive) return;
      connRef.current.send({
        type: "ANSWER",
        answer,
        isCorrect,
        playerNum: activePlayerNum,
        qIndex: currentQIndex,
      });
      processAnswer(answer, isCorrect, activePlayerNum, currentQIndex);
    } else if (mode === "versus") {
      processAnswer(answer, isCorrect, activePlayerNum, currentQIndex);
    } else {
      setUserAnswers({ ...userAnswers, [currentQIndex]: answer });
      if (!isCorrect) saveError(q.id);
      else if (mode === "errors" && isCorrect) removeError(q.id);
      if (mode === "study" || mode === "errors") setShowAnswerNow(true);
    }
  };

  const handleNextQuestionLocal = () => {
    setCurrentQIndex((prev) => prev + 1);
    setQuestionTimeLeft(60);
    setShowHint(false);
    setShowAnswerNow(false);
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  if (loading) {
    return (
      <div
        style={{
          textAlign: "center",
          marginTop: "150px",
          fontSize: "22px",
          color: "#60a5fa",
        }}
      >
        🚀 Dijital Akademi Yükleniyor...
      </div>
    );
  }

  // Modern Tema Stilleri
  const theme = {
    bg: darkMode ? "#0f172a" : "#f8fafc",
    text: darkMode ? "#f1f5f9" : "#0f172a",
    cardBg: darkMode ? "#1e293b" : "#ffffff",
    border: darkMode ? "#334155" : "#e2e8f0",
    optionBg: darkMode ? "#334155" : "#f1f5f9",
    optionHover: darkMode ? "#475569" : "#e2e8f0",
    primary: "#3b82f6",
    secondary: "#10b981",
    accent: "#8b5cf6",
    danger: "#ef4444",
  };

  return (
    <div
      style={{
        backgroundColor: theme.bg,
        color: theme.text,
        minHeight: "100vh",
        padding: "20px",
        fontFamily: "Inter, system-ui, sans-serif",
        transition: "all 0.3s ease",
      }}
    >
      <div
        style={{
          maxWidth: "750px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          minHeight: "95vh",
        }}
      >
        {/* Üst Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "25px",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "20px",
              background: "linear-gradient(90deg, #3b82f6, #8b5cf6)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            🎓 Dijital Sınav Akademisi
          </h2>
          <button
            onClick={() => setDarkMode(!darkMode)}
            style={{
              padding: "8px 16px",
              borderRadius: "20px",
              border: `1px solid ${theme.border}`,
              backgroundColor: theme.cardBg,
              color: theme.text,
              cursor: "pointer",
              fontWeight: "600",
              boxShadow: "0 2px 4px rgba(0,0,0,0.05)",
            }}
          >
            {darkMode ? "☀️ Açık Tema" : "🌙 Koyu Tema"}
          </button>
        </div>

        {/* Ana İçerik */}
        <div style={{ flex: 1 }}>
          {appState === "setup" && (
            <div
              style={{
                backgroundColor: theme.cardBg,
                padding: "30px",
                borderRadius: "20px",
                boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                border: `1px solid ${theme.border}`,
              }}
            >
              <h1
                style={{
                  textAlign: "center",
                  marginBottom: "25px",
                  fontSize: "26px",
                  fontWeight: "800",
                }}
              >
                Vize Hazırlık Paneli
              </h1>

              {/* Dosya Yükleme Kutusu */}
              <div
                style={{
                  padding: "18px",
                  backgroundColor: darkMode ? "#0f172a" : "#f1f5f9",
                  borderRadius: "14px",
                  marginBottom: "25px",
                  border: `1px dashed ${theme.primary}`,
                  textAlign: "center",
                }}
              >
                <label
                  style={{
                    fontWeight: "600",
                    display: "block",
                    marginBottom: "8px",
                    fontSize: "15px",
                  }}
                >
                  📂 Soru Veritabanı Yükle (.json)
                </label>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  style={{ cursor: "pointer", fontSize: "14px" }}
                />
                <div
                  style={{ fontSize: "13px", marginTop: "8px", opacity: 0.7 }}
                >
                  Sistemde Yüklü Soru: <strong>{allQuestions.length}</strong>
                </div>
              </div>

              <h3 style={{ fontSize: "16px", marginBottom: "12px" }}>
                1. Çalışma Modunu Seçin:
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                  marginBottom: "25px",
                }}
              >
                {[
                  {
                    id: "exam",
                    title: "⏱️ Sınav Modu",
                    desc: "Süreli, sonuç sonda",
                  },
                  {
                    id: "study",
                    title: "📖 Çalışma Modu",
                    desc: "Anında doğru cevap",
                  },
                  {
                    id: "versus",
                    title: "👥 Yan Yana Yarış",
                    desc: "20 Soru, eşli mod",
                  },
                  {
                    id: "online_versus",
                    title: "🌐 Online Oyna",
                    desc: "Uzaktan canlı düello",
                  },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setMode(m.id);
                      setMultiplayerStatus("");
                    }}
                    style={{
                      padding: "16px",
                      textAlign: "left",
                      border: `2px solid ${
                        mode === m.id ? theme.primary : theme.border
                      }`,
                      borderRadius: "14px",
                      cursor: "pointer",
                      backgroundColor:
                        mode === m.id
                          ? darkMode
                            ? "#1e3a8a"
                            : "#eff6ff"
                          : theme.optionBg,
                      color: theme.text,
                      transition: "0.2s",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: "700",
                        fontSize: "15px",
                        marginBottom: "4px",
                      }}
                    >
                      {m.title}
                    </div>
                    <div style={{ fontSize: "12px", opacity: 0.7 }}>
                      {m.desc}
                    </div>
                  </button>
                ))}

                <button
                  onClick={() => {
                    setMode("errors");
                    setMultiplayerStatus("");
                  }}
                  style={{
                    gridColumn: "span 2",
                    padding: "14px",
                    textAlign: "center",
                    border: `2px solid ${
                      mode === "errors" ? theme.danger : theme.border
                    }`,
                    borderRadius: "14px",
                    cursor: "pointer",
                    backgroundColor:
                      mode === "errors"
                        ? darkMode
                          ? "#7f1d1d"
                          : "#fee2e2"
                        : theme.optionBg,
                    color: theme.text,
                    fontWeight: "700",
                  }}
                >
                  🎯 Yanlışlarım Havuzu ({errorCount} Soru)
                </button>
              </div>

              {/* Online Oyna Detayları */}
              {mode === "online_versus" && (
                <div
                  style={{
                    padding: "20px",
                    border: `2px dashed ${theme.accent}`,
                    borderRadius: "14px",
                    marginBottom: "25px",
                    backgroundColor: darkMode ? "#1e1b4b" : "#f5f3ff",
                  }}
                >
                  <h3 style={{ marginTop: 0, color: "#a78bfa" }}>
                    🌐 Online Canlı Düello Odası
                  </h3>
                  {!myId ? (
                    <button
                      onClick={() => initPeer(true)}
                      style={{
                        width: "100%",
                        padding: "14px",
                        backgroundColor: theme.accent,
                        color: "white",
                        borderRadius: "10px",
                        border: "none",
                        cursor: "pointer",
                        fontWeight: "bold",
                      }}
                    >
                      Oda Kur (Host Ol)
                    </button>
                  ) : (
                    <div style={{ marginBottom: "15px" }}>
                      <p style={{ margin: "0 0 5px 0" }}>Oda Kodun:</p>
                      <div
                        style={{
                          fontSize: "24px",
                          fontWeight: "900",
                          color: "#c084fc",
                          letterSpacing: "2px",
                        }}
                      >
                        {myId}
                      </div>
                      <p style={{ fontSize: "13px", marginTop: "8px" }}>
                        {multiplayerStatus === "connected"
                          ? "✅ Arkadaşın odaya bağlandı!"
                          : "⏳ Arkadaşın bekleniyor..."}
                      </p>
                    </div>
                  )}
                  <hr style={{ margin: "15px 0", borderColor: theme.border }} />
                  <div>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "6px",
                        fontSize: "14px",
                        fontWeight: "600",
                      }}
                    >
                      Arkadaşının Oda Koduna Katıl:
                    </label>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <input
                        placeholder="Örn: ODA-XXXX"
                        value={joinId}
                        onChange={(e) => setJoinId(e.target.value)}
                        style={{
                          flex: 1,
                          padding: "12px",
                          borderRadius: "10px",
                          border: `1px solid ${theme.border}`,
                          backgroundColor: theme.cardBg,
                          color: theme.text,
                          fontSize: "14px",
                        }}
                      />
                      <button
                        onClick={() => {
                          initPeer(false);
                          setTimeout(joinRoom, 500);
                        }}
                        style={{
                          padding: "12px 20px",
                          backgroundColor: theme.secondary,
                          color: "white",
                          borderRadius: "10px",
                          border: "none",
                          cursor: "pointer",
                          fontWeight: "bold",
                        }}
                      >
                        Bağlan
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {mode !== "errors" && (
                <>
                  <h3>2. Dersleri Seçin:</h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "10px",
                      marginBottom: "25px",
                    }}
                  >
                    {availableCourses.map((course) => (
                      <label
                        key={course}
                        style={{
                          padding: "12px",
                          border: `1px solid ${theme.border}`,
                          borderRadius: "10px",
                          cursor: "pointer",
                          backgroundColor: selectedCourses.includes(course)
                            ? darkMode
                              ? "#334155"
                              : "#e2e8f0"
                            : "transparent",
                          display: "flex",
                          alignItems: "center",
                          fontSize: "14px",
                          fontWeight: "500",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedCourses.includes(course)}
                          onChange={() => toggleCourse(course)}
                          style={{
                            marginRight: "10px",
                            transform: "scale(1.2)",
                          }}
                        />
                        {course}
                      </label>
                    ))}
                  </div>
                </>
              )}

              {mode !== "versus" &&
                mode !== "online_versus" &&
                mode !== "errors" && (
                  <>
                    <h3>3. Soru Sayısı:</h3>
                    <select
                      value={questionCount}
                      onChange={(e) => setQuestionCount(Number(e.target.value))}
                      style={{
                        width: "100%",
                        padding: "14px",
                        borderRadius: "10px",
                        border: `1px solid ${theme.border}`,
                        backgroundColor: theme.cardBg,
                        color: theme.text,
                        marginBottom: "25px",
                        fontSize: "15px",
                      }}
                    >
                      <option value={10}>10 Soru</option>
                      <option value={20}>20 Soru</option>
                      <option value={50}>50 Soru</option>
                      <option value={100}>100 Soru</option>
                    </select>
                  </>
                )}

              {!(mode === "online_versus" && !isHost) && (
                <button
                  onClick={startQuiz}
                  disabled={
                    mode === "online_versus" &&
                    multiplayerStatus !== "connected"
                  }
                  style={{
                    width: "100%",
                    padding: "16px",
                    backgroundColor: theme.primary,
                    color: "white",
                    border: "none",
                    borderRadius: "14px",
                    fontSize: "16px",
                    cursor: "pointer",
                    fontWeight: "800",
                    boxShadow: "0 4px 12px rgba(59, 130, 246,.4)",
                    opacity:
                      mode === "online_versus" &&
                      multiplayerStatus !== "connected"
                        ? 0.5
                        : 1,
                  }}
                >
                  {mode === "versus" || mode === "online_versus"
                    ? "⚔️ Düelloyu Başlat"
                    : "Sınavı Başlat 🚀"}
                </button>
              )}
            </div>
          )}

          {appState === "quiz" &&
            (() => {
              const q = quizQuestions[currentQIndex];
              const isVs = mode === "versus" || mode === "online_versus";

              return (
                <div>
                  {isVs ? (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: "20px",
                        gap: "15px",
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          padding: "14px",
                          backgroundColor:
                            activePlayerNum === 1 ? "#1d4ed8" : theme.cardBg,
                          color: activePlayerNum === 1 ? "white" : theme.text,
                          borderRadius: "14px",
                          textAlign: "center",
                          border: `2px solid #3b82f6`,
                        }}
                      >
                        <div style={{ fontSize: "13px", opacity: 0.8 }}>
                          Oyuncu 1 (Mavi)
                        </div>
                        <div style={{ fontSize: "22px", fontWeight: "800" }}>
                          {playerScores[1]} Puan
                        </div>
                      </div>
                      <div
                        style={{
                          flex: 1,
                          padding: "14px",
                          backgroundColor:
                            activePlayerNum === 2 ? "#b91c1c" : theme.cardBg,
                          color: activePlayerNum === 2 ? "white" : theme.text,
                          borderRadius: "14px",
                          textAlign: "center",
                          border: `2px solid #ef4444`,
                        }}
                      >
                        <div style={{ fontSize: "13px", opacity: 0.8 }}>
                          Oyuncu 2 (Kırmızı)
                        </div>
                        <div style={{ fontSize: "22px", fontWeight: "800" }}>
                          {playerScores[2]} Puan
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "14px 20px",
                        backgroundColor: theme.cardBg,
                        borderRadius: "14px",
                        marginBottom: "20px",
                        border: `1px solid ${theme.border}`,
                        fontWeight: "700",
                        fontSize: "14px",
                      }}
                    >
                      {mode === "exam" && (
                        <span>
                          Süre:{" "}
                          <span style={{ color: "#60a5fa" }}>
                            {formatTime(totalTimeLeft)}
                          </span>
                        </span>
                      )}
                      <span>
                        Kalan Soru Süresi:{" "}
                        <span
                          style={{
                            color:
                              questionTimeLeft <= 10 ? "#ef4444" : "#10b981",
                          }}
                        >
                          {questionTimeLeft}s
                        </span>
                      </span>
                    </div>
                  )}

                  <div
                    style={{
                      backgroundColor: theme.cardBg,
                      padding: "30px",
                      borderRadius: "20px",
                      border: `1px solid ${theme.border}`,
                      boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                    }}
                  >
                    <div
                      style={{
                        display: "inline-block",
                        backgroundColor: theme.primary,
                        color: "white",
                        padding: "6px 14px",
                        borderRadius: "20px",
                        fontSize: "12px",
                        fontWeight: "700",
                        marginBottom: "15px",
                      }}
                    >
                      {q?.course} • Soru {currentQIndex + 1}/
                      {quizQuestions.length}
                    </div>
                    <h3
                      style={{
                        fontSize: "18px",
                        lineHeight: "1.6",
                        marginBottom: "25px",
                        fontWeight: "700",
                      }}
                    >
                      {q?.question}
                    </h3>

                    <div>
                      {q?.options.map((opt, i) => {
                        const isSelected = userAnswers[currentQIndex] === opt;
                        const isCorrectAnswer = opt === q.correctAnswer;
                        let bgColor = theme.optionBg;
                        let borderColor = theme.border;

                        if (showAnswerNow || waitingNextTurn) {
                          if (isCorrectAnswer) {
                            bgColor = darkMode ? "#064e3b" : "#d1fae5";
                            borderColor = "#10b981";
                          } else if (isSelected && !isCorrectAnswer) {
                            bgColor = darkMode ? "#7f1d1d" : "#fee2e2";
                            borderColor = "#ef4444";
                          }
                        } else if (isSelected) {
                          bgColor = darkMode ? "#1e3a8a" : "#dbeafe";
                          borderColor = "#3b82f6";
                        }

                        return (
                          <button
                            key={i}
                            onClick={() => handleAnswer(opt)}
                            style={{
                              padding: "16px",
                              textAlign: "left",
                              border: `2px solid ${borderColor}`,
                              borderRadius: "12px",
                              cursor: "pointer",
                              fontSize: "15px",
                              marginBottom: "12px",
                              backgroundColor: bgColor,
                              color: theme.text,
                              transition: "0.2s",
                              width: "100%",
                              fontWeight: "500",
                            }}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>

                    {!isVs && (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginTop: "25px",
                        }}
                      >
                        <button
                          onClick={() => setShowHint(!showHint)}
                          style={{
                            padding: "12px 18px",
                            backgroundColor: "#f59e0b",
                            color: "white",
                            border: "none",
                            borderRadius: "10px",
                            cursor: "pointer",
                            fontWeight: "bold",
                            fontSize: "14px",
                          }}
                        >
                          💡 İpucu
                        </button>
                        <button
                          onClick={handleNextQuestionLocal}
                          style={{
                            padding: "12px 22px",
                            backgroundColor: theme.secondary,
                            color: "white",
                            border: "none",
                            borderRadius: "10px",
                            cursor: "pointer",
                            fontWeight: "bold",
                            fontSize: "14px",
                          }}
                        >
                          {currentQIndex === quizQuestions.length - 1
                            ? "Sınavı Bitir"
                            : "Sonraki ➔"}
                        </button>
                      </div>
                    )}

                    {showHint && !isVs && (
                      <div
                        style={{
                          marginTop: "20px",
                          padding: "15px",
                          backgroundColor: darkMode ? "#451a03" : "#fef3c7",
                          borderLeft: "4px solid #f59e0b",
                          borderRadius: "8px",
                          fontSize: "14px",
                        }}
                      >
                        <strong>Not:</strong> {q.hint}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

          {appState === "results" &&
            (() => {
              let score = 0;
              if (mode !== "versus" && mode !== "online_versus") {
                quizQuestions.forEach((q, i) => {
                  if (userAnswers[i] === q.correctAnswer) score++;
                });
              }

              return (
                <div
                  style={{
                    backgroundColor: theme.cardBg,
                    padding: "35px",
                    borderRadius: "20px",
                    border: `1px solid ${theme.border}`,
                    textAlign: "center",
                  }}
                >
                  <h1 style={{ fontSize: "32px", marginBottom: "15px" }}>
                    🎉 Sınav Tamamlandı!
                  </h1>
                  {mode === "versus" || mode === "online_versus" ? (
                    <div>
                      <h2
                        style={{
                          fontSize: "24px",
                          color:
                            playerScores[1] > playerScores[2]
                              ? "#3b82f6"
                              : "#ef4444",
                        }}
                      >
                        {playerScores[1] > playerScores[2]
                          ? "🏆 Kazanan: Oyuncu 1!"
                          : playerScores[2] > playerScores[1]
                          ? "🏆 Kazanan: Oyuncu 2!"
                          : "🤝 Berabere!"}
                      </h2>
                      <p style={{ fontSize: "18px", marginBottom: "25px" }}>
                        Mavi: <strong>{playerScores[1]}</strong> - Kırmızı:{" "}
                        <strong>{playerScores[2]}</strong>
                      </p>
                    </div>
                  ) : (
                    <h2
                      style={{
                        color: theme.primary,
                        fontSize: "26px",
                        marginBottom: "25px",
                      }}
                    >
                      Doğru Sayısı: {score} / {quizQuestions.length}
                    </h2>
                  )}

                  <button
                    onClick={() => {
                      setAppState("setup");
                      setMultiplayerStatus("");
                    }}
                    style={{
                      padding: "14px 28px",
                      backgroundColor: theme.primary,
                      color: "white",
                      border: "none",
                      borderRadius: "12px",
                      fontSize: "16px",
                      fontWeight: "bold",
                      cursor: "pointer",
                    }}
                  >
                    Ana Menüye Dön
                  </button>
                </div>
              );
            })()}
        </div>

        {/* Telif Hakkı (Copyright) Bilgisi */}
        <footer
          style={{
            textAlign: "center",
            marginTop: "40px",
            padding: "15px 0",
            borderTop: `1px solid ${theme.border}`,
            fontSize: "13px",
            opacity: 0.6,
          }}
        >
          © 2026 Dijital Sınav ve Akademi Platformu. Tüm hakları saklıdır.
          Eğitim ve bireysel hazırlık amaçlı geliştirilmiştir.
        </footer>
      </div>
    </div>
  );
}
