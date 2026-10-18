(() => {
  "use strict";
  let active;
  // The web Code composer's picker must list the folder from inside the
  // tenant's Cowork VM, so it has its own route (answered by the guest runner).
  // Every other folder flow keeps the bridge's workspace listing.
  function folderApi(source) {
    return source === "code" ? "/api/remote/code-folders" : "/api/remote/folders";
  }
  // How long the Code picker keeps asking while its VM boots. Each attempt is
  // answered as soon as the bridge knows the guest is not up yet (503); the
  // runner comes online while the picker shows "Starting the workspace…".
  const codeStartWaitMs = 120000;
  const codeRetryDelayMs = 1500;
  async function listing(path, signal, source) {
    // A bridge that cannot answer must not leave the dialog on its loading
    // line forever: bound the read, and let the catch below show the reason.
    let effective = signal;
    try {
      if (typeof AbortSignal.timeout === "function") {
        const timeout = AbortSignal.timeout(30000);
        effective = typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, timeout]) : timeout;
      }
    } catch {}
    const response = await fetch(`${folderApi(source)}${path ? `?path=${encodeURIComponent(path)}` : ""}`, { signal: effective });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || "Could not browse server folders");
      error.status = response.status;
      throw error;
    }
    return result.value;
  }
  globalThis.__CLAUDE_PICK_SERVER_FOLDERS__ = function ({ title, multiple = false, initialPath, allowCreate = true, source = "" } = {}) {
    if (active) return active;
    active = new Promise(resolve => {
      const previousFocus = document.activeElement;
      const controller = new AbortController();
      const selected = new Set();
      const dialog = document.createElement("dialog");
      dialog.className = "remote-folder-picker";
      dialog.setAttribute("aria-labelledby", "remote-folder-picker-title");
      dialog.setAttribute("aria-describedby", "remote-folder-picker-hint");
      const header = document.createElement("div");
      header.className = "remote-folder-picker-header";
      const introduction = document.createElement("div");
      const heading = document.createElement("h2");
      heading.id = "remote-folder-picker-title";
      heading.textContent = title || "Choose a server folder";
      const hint = document.createElement("p");
      hint.id = "remote-folder-picker-hint";
      hint.textContent = multiple ? "Select folders from your workspace." : "Choose a folder from your workspace.";
      introduction.append(heading, hint);
      header.append(introduction);
      const navigation = document.createElement("div");
      navigation.className = "remote-folder-picker-navigation";
      const pathLabel = document.createElement("p");
      pathLabel.className = "remote-folder-picker-path";
      const status = document.createElement("p");
      status.className = "remote-folder-picker-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const entries = document.createElement("div");
      entries.className = "remote-folder-picker-entries";
      const search = document.createElement("input");
      search.type = "search";
      search.className = "remote-folder-picker-search";
      search.placeholder = "Find a folder…";
      search.setAttribute("aria-label", "Filter folders in this directory");
      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const row of entries.children) {
          row.hidden = !!row.dataset.name && !row.dataset.name.includes(query);
          if (row.dataset.name && !row.hidden) visible++;
        }
        status.textContent = current?.folders.length && !visible ? "No matching folders." : "";
      });
      const footer = document.createElement("div");
      footer.className = "remote-folder-picker-footer";
      let current, generation = 0, finished = false, busy = false;
      function button(label, action, parent) {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = label;
        node.addEventListener("click", action);
        parent.append(node);
        return node;
      }
      function finish(value) {
        if (finished) return;
        finished = true;
        controller.abort();
        dialog.close();
        dialog.remove();
        previousFocus?.focus?.();
        resolve(value);
      }
      const root = button("Workspace", () => load(), navigation);
      const up = button("Up", () => current?.parent && load(current.parent), navigation);
      up.setAttribute("aria-label", "Go to parent folder");
      up.className = "remote-folder-picker-up";
      const close = button("×", () => finish(null), header);
      close.className = "remote-folder-picker-close";
      close.setAttribute("aria-label", "Close folder picker");
      // "New folder": creating a directory is part of the native dialog these
      // flows replace — its `properties` carries `createDirectory` — so the
      // in-page picker offers it too. The name is a single path segment, and the
      // bridge re-validates it against the same workspace confinement as the
      // listing before it creates anything.
      const createRow = document.createElement("div");
      createRow.className = "remote-folder-picker-create";
      createRow.hidden = true;
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "remote-folder-picker-name";
      nameInput.placeholder = "New folder name";
      nameInput.setAttribute("aria-label", "New folder name");
      nameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          void create();
        }
      });
      createRow.append(nameInput);
      const createButton = button("Create folder", () => void create(), createRow);
      createButton.className = "remote-folder-picker-primary";
      const newFolder = allowCreate
        ? button("New folder", () => {
          createRow.hidden = !createRow.hidden;
          if (!createRow.hidden) nameInput.focus();
        }, footer)
        : null;
      if (newFolder) newFolder.className = "remote-folder-picker-new";
      const cancel = button("Cancel", () => finish(null), footer);
      const choose = button("Choose folder", async () => {
        if (busy || !current) return;
        const paths = multiple ? [...selected] : [current.path];
        if (!paths.length) return;
        busy = true;
        choose.disabled = true;
        try {
          // Revalidate selections on the server immediately before returning
          // paths to Desktop (folders can disappear while the dialog is open).
          const confirmed = [];
          for (const path of paths) confirmed.push((await listing(path, controller.signal, source)).path);
          finish([...new Set(confirmed)]);
        } catch (error) {
          if (!finished) status.textContent = error.message;
        } finally {
          busy = false;
          updateSelection();
        }
      }, footer);
      choose.className = "remote-folder-picker-primary";
      function updateSelection() {
        choose.textContent = multiple ? `Choose folders (${selected.size})` : "Choose this folder";
        choose.disabled = busy || !current || (multiple && selected.size === 0);
      }
      function checkbox(path, label, parent) {
        const wrapper = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(path);
        input.setAttribute("aria-label", label);
        input.addEventListener("change", () => {
          if (input.checked) selected.add(path); else selected.delete(path);
          updateSelection();
        });
        wrapper.append(input);
        parent.append(wrapper);
      }
      // Abort-aware sleep: closing the dialog cancels a retry loop at once.
      function delay(ms) {
        return new Promise(resolve => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
      async function load(path) {
        const request = ++generation;
        busy = true;
        updateSelection();
        const startDeadline = Date.now() + codeStartWaitMs;
        status.textContent = "Loading server folders…";
        try {
          let value;
          // A Code listing is answered only from inside the tenant's VM. While
          // the VM boots the bridge answers 503 (or 504 if a runner did not
          // answer in time), so the picker keeps asking and says what it is
          // waiting for — it never falls back to the bridge's own mount.
          for (;;) {
            try {
              value = await listing(path, controller.signal, source);
              break;
            } catch (error) {
              const retryable = source === "code"
                && (error?.status === 503 || error?.status === 504);
              if (!retryable || Date.now() >= startDeadline
                || finished || request !== generation) {
                throw error;
              }
              status.textContent = "Starting the workspace…";
              await delay(codeRetryDelayMs);
              if (finished || request !== generation) return false;
              status.textContent = "Loading server folders…";
            }
          }
          if (finished || request !== generation) return false;
          current = value;
          pathLabel.textContent = value.path;
          pathLabel.title = value.path;
          search.value = "";
          up.disabled = !value.parent;
          entries.replaceChildren();
          if (multiple) {
            const row = document.createElement("div");
            row.className = "remote-folder-picker-row";
            checkbox(value.path, "Include this folder", row);
            const label = document.createElement("span");
            label.textContent = "Include this folder";
            row.append(label);
            entries.append(row);
          }
          for (const folder of value.folders) {
            const row = document.createElement("div");
            row.className = "remote-folder-picker-row";
            row.dataset.name = folder.name.toLocaleLowerCase();
            if (multiple) checkbox(folder.path, `Select ${folder.name}`, row);
            const open = button(folder.name, () => load(folder.path), row);
            open.className = "remote-folder-picker-folder";
            open.title = `Open ${folder.name}`;
            entries.append(row);
          }
          status.textContent = value.truncated ? "Showing the first 1,000 folders." : value.folders.length ? "" : "This folder has no subfolders.";
          return true;
        } catch (error) {
          if (!finished && request === generation) status.textContent = error.message;
          return false;
        } finally {
          if (!finished && request === generation) {
            busy = false;
            updateSelection();
          }
        }
      }
      async function create() {
        if (busy || !current) return;
        const name = nameInput.value.trim();
        if (!name) {
          status.textContent = "Enter a folder name.";
          return;
        }
        busy = true;
        createButton.disabled = true;
        choose.disabled = true;
        status.textContent = "Creating folder…";
        try {
          const response = await fetch(folderApi(source), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: current.path, name }),
            signal: controller.signal,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) {
            const error = new Error(result.error || "Could not create the folder");
            error.status = response.status;
            throw error;
          }
          const created = result.value?.path;
          nameInput.value = "";
          createRow.hidden = true;
          // Navigate into the new folder so it is what "Choose this folder"
          // selects; in multi-select, tick it as well.
          if (multiple && created) selected.add(created);
          await load(created || current.path);
          if (created) status.textContent = `Created ${created}.`;
        } catch (error) {
          if (!finished) {
            status.textContent = error.status === 503 || error.status === 504
              ? "The workspace is still starting. Try again in a moment."
              : error.message;
          }
        } finally {
          busy = false;
          createButton.disabled = false;
          updateSelection();
        }
      }
      navigation.append(pathLabel);
      dialog.append(header, navigation, search, entries, status, createRow, footer);
      // Native dialog backdrop events target the dialog itself. Require both
      // pointer-down and click outside so dragging from inside never dismisses.
      let pressedOutside = false;
      function outside(event) {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom);
      }
      dialog.addEventListener("pointerdown", event => { pressedOutside = outside(event); });
      dialog.addEventListener("click", event => {
        if (pressedOutside && outside(event)) finish(null);
        pressedOutside = false;
      });
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
      dialog.addEventListener("close", () => finish(null));
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
      // A caller may offer a starting folder outside the browsable workspace
      // (Desktop's own default is the home directory); fall back to the
      // workspace root rather than leaving the picker stuck on an error.
      load(initialPath).then(ok => {
        if (!ok && initialPath) load();
      });
    }).finally(() => { active = undefined; });
    return active;
  };
})();
