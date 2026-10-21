import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../../api";
import type { ModelOption } from "../../api";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  XIcon,
} from "blode-icons-react";
import { PendingBar } from "./shared";

/** The model picker's layout. A model pinned here sits at the root of every
 *  account's composer menu, in this order; every other model stays selectable
 *  under "More models". The page edits a working copy and commits it as one
 *  deployment-wide setting. */
export function ModelsPage() {
  const [mainModels, setMainModels] = useState<string[]>([]);
  const [savedModels, setSavedModels] = useState<string[]>([]);
  const [catalogue, setCatalogue] = useState<ModelOption[]>([]);
  const [catalogueError, setCatalogueError] = useState("");
  const [filter, setFilter] = useState("");
  const [newModel, setNewModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [settingsResult, catalogueResult] = await Promise.allSettled([
      api.getSettings(),
      api.modelCatalogue(),
    ]);

    if (settingsResult.status === "fulfilled") {
      const list = settingsResult.value.settings.model_picker_main_models;
      setMainModels(list);
      setSavedModels(list);
      setSettingsLoaded(true);
    } else {
      const reason = settingsResult.reason;
      // Without the stored list there is nothing safe to edit: saving the blank
      // working copy would erase the deployment's layout.
      setSettingsLoaded(false);
      setError(
        reason instanceof ApiError ? reason.message : "could not load the deployment settings",
      );
    }

    // An empty catalogue is normal — a gateway in discovery mode reports
    // nothing until its instance has served a page — but a failed one is
    // worth saying out loud, or the card is just an unexplained empty list.
    if (catalogueResult.status === "fulfilled") {
      setCatalogue(catalogueResult.value);
      setCatalogueError("");
    } else {
      const reason = catalogueResult.reason;
      setCatalogue([]);
      setCatalogueError(reason instanceof ApiError ? `HTTP ${reason.status}` : "no answer");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function nameFor(id: string): string {
    return catalogue.find((model) => model.id.toLowerCase() === id.toLowerCase())?.name ?? id;
  }

  function touch() {
    setSavedNote("");
    setError("");
  }

  function addModel(raw: string) {
    const id = raw.trim();
    if (!id) return;
    setMainModels((current) =>
      current.some((chosen) => chosen.toLowerCase() === id.toLowerCase())
        ? current
        : [...current, id],
    );
    setNewModel("");
    touch();
  }

  function removeModel(id: string) {
    setMainModels((current) => current.filter((chosen) => chosen !== id));
    touch();
  }

  function moveModel(id: string, delta: number) {
    setMainModels((current) => {
      const from = current.findIndex((chosen) => chosen === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
    touch();
  }

  function addFromForm(event: FormEvent) {
    event.preventDefault();
    addModel(newModel);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const { settings } = await api.updateSettings({
        model_picker_main_models: mainModels,
      });
      // The server trims, de-duplicates and bounds the list; its answer is what
      // the page shows afterwards.
      setMainModels(settings.model_picker_main_models);
      setSavedModels(settings.model_picker_main_models);
      setSavedNote("Saved — takes effect the next time a page loads.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save the model picker");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setMainModels(savedModels);
    setError("");
    setSavedNote("");
  }

  const dirty =
    mainModels.length !== savedModels.length ||
    mainModels.some(
      (id, index) => id.toLowerCase() !== savedModels[index].toLowerCase(),
    );

  const needle = filter.trim().toLowerCase();
  const available = catalogue.filter((model) => {
    if (mainModels.some((id) => id.toLowerCase() === model.id.toLowerCase())) return false;
    if (!needle) return true;
    return `${model.name} ${model.id}`.toLowerCase().includes(needle);
  });

  const catalogueMessage = catalogueError
    ? `Could not read this deployment's model list (${catalogueError}) — add a model by id below.`
    : "This deployment's instance has not reported its model list yet — open the app once, or add a model by id below.";

  // The composer's menu, as the current working copy would lay it out. It
  // updates as models move in and out of the pinned list.
  const hasMore = mainModels.length > 0 && catalogue.some(
    (model) => !mainModels.some((id) => id.toLowerCase() === model.id.toLowerCase()),
  );

  if (loading) {
    return (
      <div className="admin-page">
        <p className="admin-loading-inline">Loading models…</p>
      </div>
    );
  }

  if (!settingsLoaded) {
    return (
      <div className="admin-page">
        <header className="admin-page-head">
          <h2 className="admin-section-title">Models</h2>
          <p className="admin-lede">
            Choose what sits at the root of every account&rsquo;s model menu, in order.
          </p>
        </header>
        <p className="admin-error" role="alert">
          {error || "could not load the deployment settings"}
        </p>
        <p className="admin-empty">
          The model picker was left untouched. Reload the settings when the auth service
          is reachable again.
        </p>
        <div>
          <button type="button" className="admin-btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`admin-page${dirty ? " has-bar" : ""}`}>
      <div className="admin-models-head">
        <header className="admin-page-head">
          <h2 className="admin-section-title">Models</h2>
          <p className="admin-lede">
            These models sit at the root of every account&rsquo;s composer menu, in the
            order below. Everything else stays selectable under &ldquo;More
            models&rdquo;. Changes take effect the next time a page loads.
          </p>
        </header>
        <aside className="admin-preview" aria-label="Composer menu preview">
          <span className="admin-field-label">Composer menu</span>
          <div className="admin-preview-menu">
            {mainModels.length === 0 ? (
              <div className="admin-preview-row is-muted">
                <span>Every model at the root</span>
              </div>
            ) : (
              <>
                {mainModels.slice(0, 4).map((id, index) => (
                  <div className="admin-preview-row" key={id}>
                    <span>{nameFor(id)}</span>
                    {index === 0 ? <CheckIcon size={14} /> : null}
                  </div>
                ))}
                {mainModels.length > 4 ? (
                  <div className="admin-preview-row is-muted">
                    <span>+{mainModels.length - 4} more at the root</span>
                  </div>
                ) : null}
                {hasMore ? (
                  <div className="admin-preview-row is-muted admin-preview-more">
                    <span>More models</span>
                    <ChevronRightIcon size={14} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>

      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}
      {savedNote ? (
        <p className="admin-note admin-note--success" role="status">
          {savedNote}
        </p>
      ) : null}

      <section className="admin-model-group" aria-labelledby="admin-main-models">
        <div className="admin-group-label" id="admin-main-models">
          Main models
          <span className="admin-count">{mainModels.length}</span>
        </div>
        {mainModels.length === 0 ? (
          <p className="admin-empty">
            Nothing pinned — every model stays at the root of the menu.
          </p>
        ) : (
          <div className="admin-rows">
            {mainModels.map((id, index) => {
              const name = nameFor(id);
              return (
                <div className="admin-model-row" key={id}>
                  <span className="admin-model-name">{name}</span>
                  {name !== id ? <code className="admin-model-id">{id}</code> : null}
                  <span className="admin-model-controls">
                    <button
                      type="button"
                      className="admin-icon-btn"
                      aria-label={`Move ${name} up`}
                      disabled={index === 0}
                      onClick={() => moveModel(id, -1)}
                    >
                      <ChevronUpIcon />
                    </button>
                    <button
                      type="button"
                      className="admin-icon-btn"
                      aria-label={`Move ${name} down`}
                      disabled={index === mainModels.length - 1}
                      onClick={() => moveModel(id, 1)}
                    >
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className="admin-icon-btn admin-icon-btn--danger"
                      aria-label={`Remove ${name} from the main models`}
                      onClick={() => removeModel(id)}
                    >
                      <XIcon />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="admin-model-group" aria-labelledby="admin-model-catalogue">
        <div className="admin-group-label" id="admin-model-catalogue">
          Catalogue
          {catalogue.length > 0 ? (
            <span className="admin-count">{catalogue.length}</span>
          ) : null}
        </div>

        {catalogue.length > 8 ? (
          <label className="admin-field admin-filter">
            <span className="admin-field-label">Filter</span>
            <input
              className="admin-input"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="name or id"
              type="search"
            />
          </label>
        ) : null}

        {catalogue.length === 0 ? (
          <p className="admin-empty">{catalogueMessage}</p>
        ) : available.length === 0 ? (
          <p className="admin-empty">
            {needle
              ? "No model matches that filter."
              : "Every model in the catalogue is already at the root."}
          </p>
        ) : (
          <div className="admin-catalogue">
            {available.map((model) => (
              <div className="admin-catalogue-row" key={model.id}>
                <span className="admin-model-name">{model.name}</span>
                {model.name !== model.id ? (
                  <code className="admin-model-id">{model.id}</code>
                ) : null}
                <button
                  type="button"
                  className="admin-btn admin-btn--small"
                  onClick={() => addModel(model.id)}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="admin-add-form" onSubmit={addFromForm}>
          <label className="admin-field">
            <span className="admin-field-label">Add a model id</span>
            <input
              className="admin-input"
              value={newModel}
              onChange={(event) => setNewModel(event.target.value)}
              placeholder="claude-opus-5-5"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button className="admin-btn" disabled={!newModel.trim()}>
            Add
          </button>
        </form>
      </section>

      {dirty ? (
        <PendingBar
          text="You have unsaved changes."
          action="Save"
          busyLabel="Saving…"
          busy={busy}
          onAction={() => void save()}
          onDiscard={discard}
        />
      ) : null}
    </div>
  );
}
