import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { api } from "./api";
import { App } from "./app";

async function boot() {
  // xterm measures glyphs on open, so the font must be loaded first.
  await Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('bold 13px "JetBrains Mono"')]);
  const shell = await api.shellInfo();
  await new App(shell).start();
  document.getElementById("boot")?.remove();
}

boot().catch((err) => {
  document.querySelector("#boot pre")!.textContent = `boot failure: ${err}`;
});
