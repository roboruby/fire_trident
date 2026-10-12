import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Landing } from "./landing/Landing.tsx";
import { parseRoute } from "./route.ts";
import "./styles.css";

const route = parseRoute(location.pathname, location.search);
const root = document.getElementById("root");
if (root) createRoot(root).render(route.kind === "landing" ? <Landing /> : <App route={route} />);
