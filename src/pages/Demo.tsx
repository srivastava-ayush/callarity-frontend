import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import texture from "../assets/paper-texture.webp";
import { Link } from "react-router";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

type Message = { text: string; sender: "user" | "ai" };
type Step = "idle" | "waiting_name" | "waiting_product" | "waiting_issue" | "done";
type ComplaintTicket = { name?: string; product_id?: string; issue?: string; date?: string };
type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type BrowserSpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const BAR_COUNT = 32;
const SpeechRecognitionCtor =
  typeof window !== "undefined"
    ? (window as BrowserSpeechRecognitionWindow).SpeechRecognition ||
      (window as BrowserSpeechRecognitionWindow).webkitSpeechRecognition
    : undefined;

export default function App() {
  const [volume, setVolume] = useState(0);
  const [messages, setMessages] = useState<Message[]>([
    { text: "Hey! I'm here to help with product issues. Just say “I want to file a complaint.”", sender: "ai" },
  ]);
  const [language, setLanguage] = useState<"english" | "hindi">("english");

  const [listening, setListening] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [thinking, setThinking] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isSpeakingRef = useRef(false);
  const stepRef = useRef<Step>("idle");
  const ticketRef = useRef<ComplaintTicket>({});
  const hasGreeted = useRef(false);

  useEffect(() => {
    speechSynthesis.getVoices();
    setTimeout(() => speechSynthesis.getVoices(), 200);
  }, []);

  useEffect(() => {
    if (!SpeechRecognitionCtor || recognitionRef.current) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognitionRef.current = recognition;
  }, []);

  // -------- UI helpers --------
  const addMessage = (text: string, sender: "user" | "ai") =>
    setMessages((prev) => [...prev, { text, sender }]);

async function humanize(text: string) {
  try {
    setThinking(true);
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5",
        prompt: `Rewrite the text below in a natural, friendly, human tone.
        Respond ONLY in ${language}. 
        Do NOT say you're rewriting anything.
        Do NOT include quotes, explanations, or meta-text.
        Text: ${text}`,
        stream: false,
      }),
    });
    const data = await res.json();
    setThinking(false);
    return (data.response || text).trim();
  } catch {
    return text;
  }
}

const eleven = new ElevenLabsClient({
  apiKey: "sk_7c8e102ca0cb82c479929c232073244dfbfb14a6156bc461", 
  environment: "https://api.elevenlabs.io",
});

async function say(text: string, after?: () => void) {
  const natural = await humanize(text);
  addMessage(natural, "ai");

  try {
    // Create a MediaSource to feed MP3 chunks into as they arrive
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);

    audio.onended = () => {
      after?.();
      if (autoMode) startListening();
    };

    audio.play().catch(console.warn);

    // Wait for the MediaSource to be open before appending data
    mediaSource.addEventListener("sourceopen", async () => {
      const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");

      const stream = await eleven.textToSpeech.stream("A7AUsa1uITCDpK29MG3m", {
        outputFormat: "mp3_44100_128",
        text: natural,
         modelId: "eleven_multilingual_v2",
      });

      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = new Uint8Array(value);
        await new Promise((resolve) => {
          const onUpdate = () => {
            sourceBuffer.removeEventListener("updateend", onUpdate);
            resolve(null);
          };
          sourceBuffer.addEventListener("updateend", onUpdate);
          sourceBuffer.appendBuffer(buffer);
        });
      }

      // Signal the end of stream
      mediaSource.endOfStream();
    });
  } catch (err) {
    console.warn("ElevenLabs real-time streaming failed, falling back to browser TTS.", err);
    const utter = new SpeechSynthesisUtterance(natural);
    utter.onend = () => {
      after?.();
      if (autoMode) startListening();
    };
    speechSynthesis.speak(utter);
  }
}

function startListening() {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    try { recognition.start(); setListening(true); } catch {console.log("Recognition already started");}
  }

function stopListening() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setListening(false);
      return;
    }

    try { recognition.stop(); } catch {console.log("Recognition already stopped");}; setListening(false);
  }

  // -------- Extractors --------
  const extractName = (t: string) =>
    t.replace(/^(my name is|i am|this is|it's|its)/i, "").trim();

  function extractProductId(raw: string): string | null {
    const cleaned = raw
      .replace(/\b(product|order|id|no|number|is)\b/gi, "")
      .replace(/[^\w-]/g, " ")
      .trim();
    const match = cleaned.match(/\b[A-Z0-9-]{3,}\b/i);
    return match ? match[0].toUpperCase() : null;
  }

  function extractIssue(t: string) {
    const s = t.trim();
    if (/^\w{3,}$/i.test(s)) return null;
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
  }

  function saveComplaint(ticket: ComplaintTicket) {
    const prev = JSON.parse(localStorage.getItem("complaints") || "[]") as ComplaintTicket[];
    prev.push({ ...ticket, date: new Date().toISOString() });
    localStorage.setItem("complaints", JSON.stringify(prev));
  }

  // -------- Conversation Flow / FSM --------
  async function handleTurn(text: string) {
    const lower = text.toLowerCase();

    if (!hasGreeted.current && /\b(hi|hello|hey|namaste)\b/.test(lower)) {
      hasGreeted.current = true;
      return say("Hey! Happy to help. If something went wrong, just say: “I want to file a complaint.”");
    }

    if (stepRef.current === "idle" && /\bcomplain|issue|file\b/i.test(lower)) {
      stepRef.current = "waiting_name";
      ticketRef.current = {};
      return say("Alright, let's get this sorted. May I know your name?");
    }

    if (stepRef.current === "idle") {
      return say("I only help with complaints. Just say: “I want to file a complaint.”");
    }

    // ------ Steps ------
    if (stepRef.current === "waiting_name") {
      const name = extractName(text) || text.trim();
      ticketRef.current.name = name;
      stepRef.current = "waiting_product";
      return say(`Thanks ${name.split(" ")[0]}. Could you share the product or order ID?`);
    }

    if (stepRef.current === "waiting_product") {
      const pid = extractProductId(text);
      if (!pid) return say("I didn't quite catch that. Could you repeat the product ID clearly?");
      ticketRef.current.product_id = pid;
      stepRef.current = "waiting_issue";
      return say("Got it. Now describe the issue in one short line.");
    }

    if (stepRef.current === "waiting_issue") {
      const issue = extractIssue(text);
      if (!issue) return say("Just a short sentence about the problem will do.");
      ticketRef.current.issue = issue;
      saveComplaint(ticketRef.current);
      const first = ticketRef.current.name?.split(" ")[0] || "there";
      stepRef.current = "idle";
      ticketRef.current = {};
      return say(`Thanks ${first}, your complaint is logged. We'll reach out soon.`);
    }
  }

  // -------- Speech Input --------
  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const text = event.results[0][0].transcript;
      addMessage(text, "user");
      stopListening();
      void handleTurn(text);
    };

    recognition.onerror = () => stopListening();
    recognition.onend = () => setListening(false);
  }, [handleTurn]);

  // -------- Mic Volume Wave --------
useEffect(() => {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let data: Uint8Array<ArrayBuffer> | null = null;
  let raf = 0;

  (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true, // prevent browser from boosting noise
      },
    });

    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);

    data = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const tick = () => {
      if (!analyser || !data) return;

      analyser.getByteTimeDomainData(data);

      // Compute RMS
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += ((data[i] - 128) / 128) ** 2;
      }

      let energy = Math.sqrt(sum / data.length);

      // 🚫 Noise gate (kill low room noise)
      if (energy < 0.035) energy = 0;

      // 🎚 Smooth movement (EMA)
      const SMOOTHING = 0.25;
      setVolume((prev) => prev * (1 - SMOOTHING) + energy * 1.2 * SMOOTHING);

      raf = requestAnimationFrame(tick);
    };

    tick();
  })();

  return () => {
    ctx?.close();
    cancelAnimationFrame(raf);
  };
}, []);



  // ---------- UI ----------
  return (
    <div className="w-full h-full relative overflow-hidden" style={styles.container}>
      {/* Ambient blobs */}
      <motion.div
        className="absolute top-1/3 -right-40 w-96 h-96 bg-red-500/15 rounded-full blur-[100px]"
        animate={{ x: [0, -30, 0], y: [0, 20, 0], scale: [1, 1.05, 1] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut", repeatType: "reverse" }}
      />
      <motion.div
        className="absolute bottom-1/3 -left-40 w-96 h-96 bg-red-500/15 rounded-full blur-[100px]"
        animate={{ x: [0, 30, 0], y: [0, -20, 0], scale: [1, 1.05, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut", repeatType: "reverse" }}
      />
<div className="absolute w-[1100px] h-[200%] rotate-[-45deg] bg-white/10 rounded-full filter blur-3xl "></div>
      <motion.div initial={{ scale: 0 }} animate={{ scale: 2 }} transition={{ duration: 1 }}
        className="w-full h-full absolute top-0 left-0 -z-0 bg-logo opacity-10 overflow-hidden" />

      <img src={texture} className="w-full h-full absolute top-0 opacity-40 left-0 -z-0" />

      <motion.h1
        initial={{ y: -100, opacity: 0, filter: "blur(10px)" }}
        animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
        transition={{ duration: 1 }}
        className="mt-20 text-6xl z-10"
        style={styles.title}
      >
        Callarity Demo
      </motion.h1>

      <motion.div
        initial={{ y: 100, width: "50%", opacity: 0 }}
        animate={{ y: 0, width: "60%", opacity: 1 }}
        transition={{ duration: 1 }}
        className="mt-10 z-10 w-5xl shadow-2xl border-4 relative overflow-x-hidden border-[#ffffff42] shadow-[#ffffff27] h-[80vh] bg-white/10 backdrop-blur-sm overflow-y-auto"
        style={styles.chatBox}
      >
        {/* Siri bars (top, reacts to listening/speaking/volume) */}
        <div className="sticky top-0 z-10 w-full">
          <div className="flex items-center justify-center py-3 pointer-events-none">
            <div className="flex gap-[3px]">
              {Array.from({ length: BAR_COUNT }).map((_, i) => {
                const barHeight = 10 + volume * 90 * Math.sin((i / BAR_COUNT) * Math.PI);
                return (
                  <motion.div
                    key={i}
                    animate={{ height: listening || isSpeakingRef.current ? barHeight : 1 }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                    className="w-[4px] rounded-full"
                    style={{
                      background:
                        "linear-gradient(180deg,#ff4bff,#ff00e6,#ff0066,#ff6600,#ffaa00)",
                      opacity: listening || isSpeakingRef.current ? 0.9 : 0.25,
                      filter: "drop-shadow(0 0 6px rgba(255,0,200,0.8))",
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Messages */}
        {messages.map((m, i) => (
          <div key={i} style={{ ...styles.msg, ...(m.sender === "user" ? styles.user : styles.ai) }}>
            {m.text}
          </div>
        ))}

        {/* Thinking dots */}
        {thinking && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ repeat: Infinity, duration: 0.8, repeatType: "reverse" }}
            style={{ ...styles.msg, ...styles.ai, opacity: 0.6 }}
          >
            <div className="flex gap-1">
              <span className="animate-bounce">•</span>
              <span className="animate-bounce [animation-delay:150ms]">•</span>
              <span className="animate-bounce [animation-delay:300ms]">•</span>
            </div>
          </motion.div>
        )}
      </motion.div>

      {/* Controls */}
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 1 }}
        className="flex gap-4 mb-10"
      >
        <button
          className="z-10 bg-red-700"
          style={{ ...styles.button, ...(listening ? styles.listening : {}) }}
          onClick={startListening}
        >
          {listening ? "Listening..." : "Start Talking"}
        </button>

        <button
          className="z-10"
          style={{ ...styles.button, background: autoMode ? "#00d46a" : "#555" }}
          onClick={() => setAutoMode((v) => !v)}
        >
          Auto: {autoMode ? "ON" : "OFF"}
        </button>
<button
  className="z-10 bg-gradient-to-b from-[#0088ffbe] to-blue-400  hover:from-blue-600 hover:to-blue-300" 
  style={{ ...styles.button, background: language === "english" ? "" : "#ff9100" }}
  onClick={() => setLanguage((l) => (l === "english" ? "hindi" : "english"))}
>
  {language === "english" ? "Switch to Hindi" : "Switch to English"}
</button>

       

        <Link className="z-10 border-2 border-white" to="/dashboard" style={{ ...styles.button }}>
          Dashboard
        </Link>
      </motion.div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: "100vh",
    backgroundColor: "#000",
    color: "#eee",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: "50px",
  },
  title: { color: "#fff" },
  chatBox: {
    padding: "14px",
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  msg: { padding: "10px 14px", borderRadius: "12px", maxWidth: "80%" },
  user: { background: "#4c6ef5", alignSelf: "flex-end" },
  ai: { background: "hsl(240, 100%, 1%)" ,border:"1px solid hsl(240, 100%, 90%)", alignSelf: "flex-start" },
  button: {
    marginTop: "20px",
    padding: "14px 30px",
   
    borderRadius: "50px",
    fontSize: "18px",
    color: "white",
    cursor: "pointer",
    transition: "0.2s",
  },
  listening: { background: "#00d46a", boxShadow: "0 0 12px #00d46a" },
};
