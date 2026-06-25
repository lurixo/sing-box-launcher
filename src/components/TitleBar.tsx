import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DismissRegular,
  MaximizeRegular,
  SubtractRegular,
  SquareMultipleRegular,
} from "@fluentui/react-icons";
import { useState, useEffect } from "react";
import { useT } from "../i18n/strings";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const t = useT();

  useEffect(() => {
    const check = async () => setMaximized(await appWindow.isMaximized());
    check();
    const unlisten = appWindow.onResized(() => check());
    return () => { unlisten.then((f) => f()); };
  }, []);

  return (
    <div className="titlebar">
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.02em", color: "var(--text-primary)" }}>
        sing-box launcher
      </span>

      <div className="titlebar-buttons">
        <button
          className="titlebar-btn"
          onClick={() => appWindow.minimize()}
          aria-label={t("titlebar.minimize")}
        >
          <SubtractRegular style={{ fontSize: 16 }} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          aria-label={t("titlebar.maximize")}
        >
          {maximized ? (
            <SquareMultipleRegular style={{ fontSize: 16 }} />
          ) : (
            <MaximizeRegular style={{ fontSize: 16 }} />
          )}
        </button>
        <button
          className="titlebar-btn close"
          onClick={() => appWindow.hide()}
          aria-label={t("titlebar.close")}
        >
          <DismissRegular style={{ fontSize: 16 }} />
        </button>
      </div>
    </div>
  );
}
