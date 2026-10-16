import {
  CaretDownIcon,
  CaretUpIcon,
  PlusIcon,
  SpeakerHighIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { IconButton } from "../../components/ui/IconButton";
import { Select } from "../../components/ui/Select";
import { TextField } from "../../components/ui/TextField";
import { useI18n } from "../../i18n/i18n";
import { useAppearance } from "../appearance/AppearanceProvider";
import {
  maxWordAudioSources,
  sameWordAudioSource,
  validWordAudioUrl,
  type WordAudioSource,
} from "./wordAudio";

type Kind = WordAudioSource["kind"];

/**
 * Settings > Dictionary > Word audio: the sources Voice and Anki's Word audio content try in
 * order. Every change saves at once.
 */
export function WordAudioSettings() {
  const { wordAudioSources: sources, setWordAudioSources } = useAppearance();
  const { t } = useI18n();
  const hasJpod101 = sources.some((source) => source.kind === "jpod101");
  const [kind, setKind] = useState<Kind>(hasJpod101 ? "url" : "jpod101");
  const [url, setUrl] = useState("");
  const shownKind: Kind = kind === "jpod101" && hasJpod101 ? "url" : kind;
  const candidate: WordAudioSource =
    shownKind === "jpod101" ? { kind: "jpod101" } : { kind: shownKind, url: url.trim() };

  const name = (source: WordAudioSource) =>
    source.kind === "jpod101" ? t("wordAudio.jpod101") : source.url;
  const kindLabel = (kind: Kind) =>
    kind === "jpod101"
      ? "assets.languagepod101.com"
      : kind === "url"
        ? t("wordAudio.kindUrl")
        : t("wordAudio.kindList");

  const problem =
    sources.length >= maxWordAudioSources
      ? t("wordAudio.full", { count: maxWordAudioSources })
      : candidate.kind !== "jpod101" && !validWordAudioUrl(candidate.url)
        ? candidate.url
          ? t("wordAudio.invalidUrl")
          : ""
        : sources.some((source) => sameWordAudioSource(source, candidate))
          ? t("wordAudio.duplicate")
          : null;

  function move(index: number, to: number) {
    if (to < 0 || to >= sources.length) return;
    const next = [...sources];
    const [source] = next.splice(index, 1);
    next.splice(to, 0, source);
    setWordAudioSources(next);
  }

  function moveByKey(event: KeyboardEvent<HTMLLIElement>, index: number) {
    if (event.target !== event.currentTarget || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    move(index, event.key === "ArrowUp" ? index - 1 : index + 1);
  }

  function add() {
    if (problem !== null) return;
    setWordAudioSources([...sources, candidate]);
    setUrl("");
    if (candidate.kind === "jpod101") setKind("url");
  }

  return (
    <Card className="settings-card settings-card--wide" aria-labelledby="word-audio-title">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <SpeakerHighIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2 id="word-audio-title">{t("wordAudio.title")}</h2>
          <p>{t("wordAudio.description")}</p>
        </div>
      </div>
      <div className="settings-list">
        {sources.length > 0 ? (
          <ol className="settings-source-list" aria-label={t("wordAudio.sources")}>
            {sources.map((source, index) => (
              <li
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                className="settings-source-row settings-source-row--audio"
                key={source.kind === "jpod101" ? source.kind : `${source.kind}:${source.url}`}
                onKeyDown={(event) => moveByKey(event, index)}
                tabIndex={0}
              >
                <div>
                  <strong>{name(source)}</strong>
                  <small>{kindLabel(source.kind)}</small>
                </div>
                <IconButton
                  className="settings-source-row__move"
                  disabled={index === 0}
                  label={t("wordAudio.moveUp", { name: name(source) })}
                  onClick={() => move(index, index - 1)}
                >
                  <CaretUpIcon aria-hidden="true" weight="bold" />
                </IconButton>
                <IconButton
                  className="settings-source-row__move"
                  disabled={index === sources.length - 1}
                  label={t("wordAudio.moveDown", { name: name(source) })}
                  onClick={() => move(index, index + 1)}
                >
                  <CaretDownIcon aria-hidden="true" weight="bold" />
                </IconButton>
                <IconButton
                  className="settings-source-row__remove"
                  label={t("wordAudio.remove", { name: name(source) })}
                  onClick={() => setWordAudioSources(sources.filter((_, other) => other !== index))}
                >
                  <TrashIcon aria-hidden="true" weight="bold" />
                </IconButton>
              </li>
            ))}
          </ol>
        ) : (
          <p className="settings-source-empty">{t("wordAudio.empty")}</p>
        )}
        <div className="settings-field">
          <Select
            label={t("wordAudio.newSource")}
            value={shownKind}
            options={[
              ...(hasJpod101 ? [] : [{ value: "jpod101" as const, label: t("wordAudio.jpod101") }]),
              { value: "url" as const, label: t("wordAudio.kindUrl") },
              { value: "list" as const, label: t("wordAudio.kindList") },
            ]}
            onChange={setKind}
          />
        </div>
        {shownKind !== "jpod101" ? (
          <div className="settings-field">
            <TextField label={t("wordAudio.url")} value={url} maxLength={2048} onChange={setUrl} />
            <p className="settings-field__hint">
              {t("wordAudio.urlHint", {
                term: "{term}",
                reading: "{reading}",
                language: "{language}",
              })}
            </p>
          </div>
        ) : null}
        <div className="settings-row">
          <div>
            <strong>{t("wordAudio.add")}</strong>
            {problem ? <span role="status">{problem}</span> : null}
          </div>
          <Button
            disabled={problem !== null}
            icon={<PlusIcon aria-hidden="true" weight="bold" />}
            onClick={add}
            tone="secondary"
          >
            {t("wordAudio.addButton")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
