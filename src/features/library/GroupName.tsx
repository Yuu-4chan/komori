import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useI18n } from "../../i18n/i18n";
import { cleanGroupName } from "./libraryView";

interface GroupNameProps {
  name: string;
  /** Saves a new name; given only for a group that can be renamed. */
  onRename?: (name: string) => Promise<void>;
  className?: string;
}

// Two taps this close in time are a double tap, as Android's WebView may not send dblclick.
const DOUBLE_TAP_MS = 400;

/**
 * A group's name, which a double click or double tap edits in place when the group can be
 * renamed: Enter or leaving the field saves, Escape keeps the name.
 */
export function GroupName({ name, onRename, className }: GroupNameProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastTap = useRef(0);
  const done = useRef(false);

  function edit() {
    if (!onRename || draft !== null) return;
    done.current = false;
    setDraft(name);
  }

  function tap(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    const now = event.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      edit();
    } else lastTap.current = now;
  }

  async function save(value: string) {
    // Enter and the blur that follows the field's removal save once.
    if (done.current) return;
    done.current = true;
    const next = cleanGroupName(value);
    if (!onRename || next === null || next === name) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
    } finally {
      setSaving(false);
      setDraft(null);
    }
  }

  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void save(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      done.current = true;
      setDraft(null);
    }
  }

  if (draft !== null)
    return (
      <input
        aria-label={t("library.groupName")}
        autoFocus
        className={`group-name-field${className ? ` ${className}` : ""}`}
        disabled={saving}
        enterKeyHint="done"
        maxLength={500}
        onBlur={(event) => void save(event.currentTarget.value)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={key}
        spellCheck={false}
        value={draft}
      />
    );
  return (
    <span
      className={className}
      onDoubleClick={onRename ? edit : undefined}
      onPointerUp={onRename ? tap : undefined}
      title={name}
    >
      {name}
    </span>
  );
}
