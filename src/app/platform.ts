/** Komori on an Android phone, fixed when the frontend is built (`TAURI_ENV_PLATFORM`). */
export const isAndroid = import.meta.env.TAURI_ENV_PLATFORM === "android";
