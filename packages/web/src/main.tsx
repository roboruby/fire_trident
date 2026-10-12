import { createRoot } from "react-dom/client";

function App() {
  return <main style={{ fontFamily: "system-ui", padding: 32 }}><h1>FireTrident</h1><p>A colony, not a queue.</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
