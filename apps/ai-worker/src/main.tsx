import CardNewsApp from './CardNewsApp';
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

if (location.pathname === "/admin/publish" || location.pathname === "/admin/publish/") {
  history.replaceState(null, "", `/admin/${location.search}${location.hash}`);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname === "/admin/capture" ? <App /> : <CardNewsApp />}
  </React.StrictMode>,
);
