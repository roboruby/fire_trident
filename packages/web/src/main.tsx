import { createRoot } from "react-dom/client";
import { connectSite } from "@fire_trident/core";
import { App } from "./App.tsx";
import { AccountPage } from "./account/Account.tsx";
import { ConnectPage } from "./connect/Connect.tsx";
import { SITE } from "./landing/questions.ts";
import { Landing } from "./landing/Landing.tsx";
import { Limits } from "./limits/Limits.tsx";
import { Playback } from "./playback/Playback.tsx";
import { parseRoute } from "./route.ts";
import "./styles.css";

const route = parseRoute(location.pathname, location.search);
const root = document.getElementById("root");
// ?recording=: the colony from a recorded run, its reads answered by the recording with no network (playback/Playback.tsx).
// /connect: the commands name the deployment serving the page (the public site when its origin is not one a command can carry).
const page =
  route.kind === "landing" ? (
    <Landing />
  ) : route.kind === "limits" ? (
    <Limits />
  ) : route.kind === "account" ? (
    <AccountPage />
  ) : route.kind === "connect" ? (
    <ConnectPage site={connectSite(location.origin) ?? SITE} colony={route.colonyId} />
  ) : route.recording !== null ? (
    <Playback route={route} />
  ) : (
    <App route={route} />
  );
if (root) createRoot(root).render(page);
