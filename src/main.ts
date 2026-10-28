import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { api } from "./api";
import { App } from "./app";

async function boot() {
  // xterm measures glyphs on open, so the terminal font must be loaded first.
  await Promise.all([document.fonts.load('13px "IBM Plex Mono"'), document.fonts.load('bold 13px "IBM Plex Mono"')]);
  const shell = await api.shellInfo();
  await new App(shell).start();
  const bootEl = document.getElementById("boot");
  bootEl?.classList.add("done");
  bootEl?.addEventListener("transitionend", () => bootEl.remove(), { once: true });
}

boot().catch((err) => {
  document.querySelector(".boot-status")!.classList.add("failed");
  document.querySelector(".boot-text")!.textContent = `Boot failure: ${err}`;
});
