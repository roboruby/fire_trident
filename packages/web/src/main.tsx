import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Landing } from "./landing/Landing.tsx";
import { Playback } from "./playback/Playback.tsx";
import { parseRoute } from "./route.ts";
import "./styles.css";

const route = parseRoute(location.pathname, location.search);
const root = document.getElementById("root");
// ?recording=: the colony from a recorded run, its reads answered by the recording with no network (playback/Playback.tsx).
if (root) createRoot(root).render(route.kind === "landing" ? <Landing /> : route.recording !== null ? <Playback route={route} /> : <App route={route} />);
