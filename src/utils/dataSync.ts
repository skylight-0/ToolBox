export const TOOLBOX_DATA_CHANGED = "toolbox-data-changed";

export function notifyToolboxDataChanged(kind: string) {
  window.dispatchEvent(
    new CustomEvent(TOOLBOX_DATA_CHANGED, {
      detail: { kind },
    }),
  );
}
