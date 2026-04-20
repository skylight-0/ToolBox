import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";
import { notifyToolboxDataChanged } from "../../utils/dataSync";

type PomodoroViewProps = {
  onBack: () => void;
};

function PomodoroView({ onBack }: PomodoroViewProps) {
  const [focusDuration, setFocusDuration] = useState(25);
  const [breakDuration, setBreakDuration] = useState(5);
  const [timeLeft, setTimeLeft] = useState(focusDuration * 60);
  const [isTimerActive, setIsTimerActive] = useState(false);
  const [isBreak, setIsBreak] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tempFocusDuration, setTempFocusDuration] = useState(focusDuration.toString());
  const [tempBreakDuration, setTempBreakDuration] = useState(breakDuration.toString());

  useEffect(() => {
    Promise.all([
      invoke<string | null>("get_setting", { key: "pomodoro_focus" }),
      invoke<string | null>("get_setting", { key: "pomodoro_break" }),
    ])
      .then(([focus, breakTime]) => {
        const nextFocus = focus ? parseInt(focus, 10) : 25;
        const nextBreak = breakTime ? parseInt(breakTime, 10) : 5;
        setFocusDuration(Number.isFinite(nextFocus) ? nextFocus : 25);
        setBreakDuration(Number.isFinite(nextBreak) ? nextBreak : 5);
        setTempFocusDuration((Number.isFinite(nextFocus) ? nextFocus : 25).toString());
        setTempBreakDuration((Number.isFinite(nextBreak) ? nextBreak : 5).toString());
        setTimeLeft((Number.isFinite(nextFocus) ? nextFocus : 25) * 60);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    let interval: number | null = null;

    if (isTimerActive && timeLeft > 0) {
      interval = window.setInterval(() => {
        setTimeLeft((current) => current - 1);
      }, 1000);
    } else if (isTimerActive && timeLeft === 0) {
      setIsTimerActive(false);

      import("@tauri-apps/plugin-notification")
        .then(({ isPermissionGranted, requestPermission, sendNotification }) => {
          isPermissionGranted()
            .then((granted) => {
              if (!granted) {
                return requestPermission();
              }
              return granted ? "granted" : "default";
            })
            .then((permission) => {
              if (permission === "granted") {
                sendNotification({
                  title: isBreak ? "休息结束！" : "专注完成！",
                  body: isBreak
                    ? "休息已结束，准备开始新的专注！"
                    : "完成了一个番茄钟，休息一下吧！",
                });
              }
            });
        })
        .catch(console.error);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isBreak, isTimerActive, timeLeft]);

  const toggleTimer = () => {
    if (!isTimerActive) {
      import("@tauri-apps/plugin-notification")
        .then(({ isPermissionGranted, requestPermission }) => {
          isPermissionGranted().then((granted) => {
            if (!granted) {
              requestPermission();
            }
          });
        })
        .catch(console.error);
    }

    setIsTimerActive((current) => !current);
  };

  const resetTimer = () => {
    setIsTimerActive(false);
    setTimeLeft(isBreak ? breakDuration * 60 : focusDuration * 60);
  };

  const setMode = (breakMode: boolean) => {
    setIsBreak(breakMode);
    setIsTimerActive(false);
    setTimeLeft(breakMode ? breakDuration * 60 : focusDuration * 60);
  };

  const savePomodoroSettings = () => {
    const focus = parseInt(tempFocusDuration, 10);
    const breakValue = parseInt(tempBreakDuration, 10);

    if (focus >= 1 && focus <= 120) {
      setFocusDuration(focus);
      if (!isBreak) setTimeLeft(focus * 60);
      void invoke("set_setting", { key: "pomodoro_focus", value: focus.toString() }).catch(console.error);
    }

    if (breakValue >= 1 && breakValue <= 60) {
      setBreakDuration(breakValue);
      if (isBreak) setTimeLeft(breakValue * 60);
      void invoke("set_setting", { key: "pomodoro_break", value: breakValue.toString() }).catch(console.error);
    }

    notifyToolboxDataChanged("pomodoro");

    setShowSettings(false);
  };

  const formatTimer = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${secs}`;
  };

  const actions = (
    <button className="pomodoro-settings-btn" onClick={() => setShowSettings(true)} title="设置">
      ⚙️
    </button>
  );

  return (
    <div className="sub-view">
      <SubViewHeader title="番茄钟" onBack={onBack} actions={actions} />
      <div className="sub-view-content pomodoro-container">
        <div className="pomodoro-modes">
          <button
            className={`pomodoro-mode-btn ${!isBreak ? "active" : ""}`}
            onClick={() => setMode(false)}
          >
            专注模式 ({focusDuration}分钟)
          </button>
          <button
            className={`pomodoro-mode-btn ${isBreak ? "active" : ""}`}
            onClick={() => setMode(true)}
          >
            休息模式 ({breakDuration}分钟)
          </button>
        </div>

        <div className="pomodoro-timer-circle">
          <div className="pomodoro-time-display">{formatTimer(timeLeft)}</div>
        </div>

        <div className="pomodoro-controls">
          <button className="pomodoro-control-btn main-btn" onClick={toggleTimer}>
            {isTimerActive ? "暂停计时" : "开始计时"}
          </button>
          <button className="pomodoro-control-btn reset-btn" onClick={resetTimer}>
            重置
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="pomodoro-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="pomodoro-settings-panel" onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">番茄钟设置</h3>
            <div className="settings-row">
              <label className="settings-label">专注时间（分钟）</label>
              <input
                type="number"
                className="settings-input"
                value={tempFocusDuration}
                onChange={(event) => setTempFocusDuration(event.target.value)}
                min="1"
                max="120"
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">休息时间（分钟）</label>
              <input
                type="number"
                className="settings-input"
                value={tempBreakDuration}
                onChange={(event) => setTempBreakDuration(event.target.value)}
                min="1"
                max="60"
              />
            </div>
            <div className="settings-actions">
              <button className="settings-cancel-btn" onClick={() => setShowSettings(false)}>
                取消
              </button>
              <button className="settings-save-btn" onClick={savePomodoroSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PomodoroView;
