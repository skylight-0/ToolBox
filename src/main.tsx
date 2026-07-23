import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./App.css";

const App = lazy(() => import("./App"));
const TextManagerWindow = lazy(() => import("./features/textmanager/TextManagerWindow"));
const PasswordWindow = lazy(() => import("./features/password/PasswordWindow"));
const TestWindow = lazy(() => import("./features/screenshot/TestWindow"));
const DrawerWindow = lazy(() => import("./features/drawer/DrawerWindow"));

const hash = window.location.hash.toLowerCase();
const View: React.ReactNode =
  hash === "#textmanager" ? <TextManagerWindow /> :
  hash === "#password" ? <PasswordWindow /> :
  hash === "#test" ? <TestWindow /> :
  hash === "#drawer" ? <DrawerWindow /> :
  <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>{View}</Suspense>
  </React.StrictMode>,
);
