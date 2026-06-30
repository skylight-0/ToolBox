import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import App from "./App";
import TextManagerWindow from "./features/textmanager/TextManagerWindow";
import PasswordWindow from "./features/password/PasswordWindow";
import ScreenshotOverlay from "./features/screenshot/ScreenshotOverlay";
import PinWindow from "./features/screenshot/PinWindow";
import PinMenuWindow from "./features/screenshot/PinMenuWindow";
import TestWindow from "./features/screenshot/TestWindow";

const hash = window.location.hash.toLowerCase();
const View: React.ReactNode =
  hash === "#textmanager" ? <TextManagerWindow /> :
  hash === "#password" ? <PasswordWindow /> :
  hash === "#screenshot" ? <ScreenshotOverlay /> :
  hash === "#pin" ? <PinWindow /> :
  hash === "#pin-menu" ? <PinMenuWindow /> :
  hash === "#test" ? <TestWindow /> :
  <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {View}
  </React.StrictMode>,
);
