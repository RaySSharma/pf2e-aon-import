// AoN Import library: parse AoN CSV / JSON exports and normalize records

(function (global) {
  const AoNImport = {
    // Parse CSV text into array of objects using header row
    parseCSV(csvText) {
      if (typeof csvText !== "string")
        throw new TypeError("CSV input must be a string");
      const rows = [];
      let cur = "";
      let row = [];
      let inQuotes = false;
      for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];
        if (ch === '"') {
          if (inQuotes && next === '"') {
            // escaped quote
            cur += '"';
            i++; // skip next
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          row.push(cur);
          cur = "";
        } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
          // handle CRLF and LF
          if (cur !== "" || row.length > 0) {
            row.push(cur);
            rows.push(row);
            row = [];
            cur = "";
          }
          // skip extra \n after \r
          if (ch === "\r" && next === "\n") i++;
        } else {
          cur += ch;
        }
      }
      if (cur !== "" || row.length > 0) {
        row.push(cur);
        rows.push(row);
      }

      if (rows.length === 0) return [];

      // Use first row as header
      const header = rows[0].map((h) => (h || "").trim());
      const out = [];
      for (let r = 1; r < rows.length; r++) {
        const rec = {};
        const cols = rows[r];
        for (let c = 0; c < header.length; c++) {
          const key = header[c] || `field${c}`;
          rec[key] = cols[c] !== undefined ? cols[c].trim() : "";
        }
        out.push(rec);
      }
      return out;
    },

    // Parse AoN JSON (either string or parsed object)
    parseJSON(json) {
      let obj;
      if (typeof json === "string") {
        obj = JSON.parse(json);
      } else {
        obj = json;
      }
      // AoN exports may provide an array or an object with an items array
      if (Array.isArray(obj))
        return obj.map((item) => this.normalizeRecord(item));
      if (obj && Array.isArray(obj.items))
        return obj.items.map((item) => this.normalizeRecord(item));
      // Fallback: if it's an object with keys representing records, map values
      if (obj && typeof obj === "object")
        return Object.values(obj).map((item) => this.normalizeRecord(item));
      return [];
    },

    // Normalize a single record (object with arbitrary keys) into standard internal shape
    normalizeRecord(record) {
      if (!record || typeof record !== "object") return null;
      const r = {};
      const getField = (names) => {
        for (const n of names) {
          if (
            n in record &&
            record[n] !== null &&
            record[n] !== undefined &&
            String(record[n]).trim() !== ""
          )
            return record[n];
        }
        // also try lowercased keys
        const keys = Object.keys(record);
        for (const k of keys) {
          const lk = k.toLowerCase();
          for (const n of names) {
            if (lk === n.toLowerCase()) return record[k];
          }
        }
        return undefined;
      };

      r.name = getField(["name", "Name", "item_name", "title"]) || "";
      r.type = getField(["type", "Type", "item_type"]) || "";
      r.description =
        getField(["description", "Description", "desc", "text"]) || "";
      r.source = getField(["source", "Source"]) || "";
      r.quantity =
        parseInt(
          getField(["quantity", "qty", "Quantity"]) || getField(["count"]) || 1,
          10
        ) || 1;

      // Price parsing: handle strings like "12 gp" or "12.5"
      const priceRaw = getField(["price", "Price", "cost", "Cost"]);
      r.price = null;
      if (
        priceRaw !== undefined &&
        priceRaw !== null &&
        String(priceRaw).trim() !== ""
      ) {
        let p = String(priceRaw).trim();
        // remove currency abbreviations and non-numeric except . and , and -
        p = p.replace(/[^0-9.,-]/g, "");
        // If contains comma and dot, assume comma thousands -> remove commas
        if (p.indexOf(",") !== -1 && p.indexOf(".") !== -1)
          p = p.replace(/,/g, "");
        // If only commas present, replace commas with dot for decimal
        else if (p.indexOf(",") !== -1) p = p.replace(/,/g, ".");
        const f = parseFloat(p);
        if (!Number.isNaN(f)) r.price = f;
      }

      // Level parsing
      r.level = null;
      const lvl = getField(["level", "Level", "item_level"]);
      if (lvl !== undefined && lvl !== null && String(lvl).trim() !== "") {
        const n = parseInt(String(lvl).replace(/[^0-9-]/g, ""), 10);
        if (!Number.isNaN(n)) r.level = n;
      }

      // Bulk and weight
      r.bulk = getField(["bulk", "Bulk", "weight", "Weight"]) || "";

      // Traits / categories
      let traitsRaw = getField([
        "traits",
        "Traits",
        "tags",
        "Categories",
        "category",
      ]);
      if (traitsRaw === undefined || traitsRaw === null) traitsRaw = "";
      if (Array.isArray(traitsRaw))
        r.traits = traitsRaw.map((t) => String(t).trim()).filter(Boolean);
      else if (typeof traitsRaw === "string") {
        r.traits = traitsRaw
          .split(/[,;|\/]+/)
          .map((t) => t.trim())
          .filter(Boolean);
      } else r.traits = [];

      // Keep original record for reference
      r.raw = record;

      return r;
    },

    // Auto-detect input type and parse accordingly. `input` can be string (CSV/JSON) or object
    parse(input) {
      if (input == null) return [];
      if (typeof input === "string") {
        const s = input.trim();
        if (s.startsWith("{") || s.startsWith("[")) {
          // JSON
          try {
            return this.parseJSON(JSON.parse(s));
          } catch (e) {
            throw new Error("Invalid JSON provided to AoNImport.parse");
          }
        } else {
          // treat as CSV
          const arr = this.parseCSV(s);
          return arr.map((item) => this.normalizeRecord(item));
        }
      }
      if (Array.isArray(input))
        return input.map((i) => this.normalizeRecord(i));
      if (typeof input === "object") {
        // try parseJSON behavior
        return this.parseJSON(input);
      }
      return [];
    },
    // In-memory map of compiled matches: { normalizedName: [ {pack, packLabel, id, name, type, document?}, ... ] }
    matches: {},

    // Search PF2e compendia for items matching `name` (case-insensitive). Returns an array of match descriptors.
    // Options: { retrieveDocument: boolean } - if true, fetch full document for each match.
    async findInPF2eCompendia(name, options = { retrieveDocument: false }) {
      const out = [];
      if (!name) return out;
      const queryName = String(name).trim().toLowerCase();
      if (!queryName) return out;

      // If Foundry `game.packs` is not available (e.g., running outside Foundry), return empty.
      if (typeof game === "undefined" || !game.packs) return out;

      const packs = Array.from(game.packs.values());
      for (const pack of packs) {
        try {
          const meta = pack.metadata || {};
          // Only search PF2e system packs
          if (meta.system !== "pf2e") continue;

          const index = await pack.getIndex();
          // Normalize index values into an array of entries
          const idxValues =
            index && typeof index.values === "function"
              ? Array.from(index.values())
              : Array.isArray(index)
              ? index
              : [];
          for (const entry of idxValues) {
            const entryName = String(entry.name || entry?.data?.name || "")
              .trim()
              .toLowerCase();
            if (entryName === queryName) {
              const docId = entry._id || entry.id || entry._key || null;
              if (!docId) continue;
              let itemDoc = null;
              try {
                if (typeof pack.getDocument === "function") {
                  itemDoc = await pack.getDocument(docId);
                } else if (typeof pack.get === "function") {
                  itemDoc = await pack.get(docId);
                }
              } catch (e) {
                console.warn(
                  "AoNImport: failed to retrieve item document from pack",
                  pack.collection,
                  docId,
                  e
                );
                continue;
              }
              if (itemDoc) {
                const data = itemDoc.toObject
                  ? itemDoc.toObject()
                  : duplicate(itemDoc);
                out.push(itemDoc);
              }
            }
          }
        } catch (err) {
          // Non-fatal: continue searching other packs
          console.warn("AoNImport: error searching pack", pack.collection, err);
        }
      }
      return out;
    },

    // Build a compiled matches map for an array of normalized records.
    // `records` may be an array of normalized records or raw input passed to `parse`.
    // Options forwarded to finder: { retrieveDocument }
    async compileMatches(records, options = { retrieveDocument: false }) {
      const normalized = Array.isArray(records) ? records : this.parse(records);
      const map = {};
      for (const rec of normalized) {
        if (!rec || !rec.name) continue;
        const key = String(rec.name).trim();
        if (!key) continue;
        const matches = await this.findInPF2eCompendia(key, options);
        map[key] = matches;
      }
      // store internally for later use
      this.matches = map;
      return map;
    },
  };

  // Expose globally
  global.AoNImport = AoNImport;
})(this);

// Add UI helper to open a file picker (Foundry FilePicker or browser file input)
(function (global) {
  const AoN = global.AoNImport;
  if (!AoN) return;

  AoN.lastParsed = null;

  // Read text from a File object
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  }

  // Open the Foundry FilePicker to choose a file from server (if available), otherwise fall back to local file input
  AoN.openImportDialog = async function () {
    let activeSource = "data";
    let picker = foundry.applications.apps.FilePicker;

    // Running on The Forge
    if (typeof ForgeVTT != "undefined" && ForgeVTT.usingTheForge) {
      activeSource = "forgevtt";
      picker = ForgeVTT_FilePicker;
    }
    // FilePicker
    return new Promise((resolve) => {
      const filePicker = new picker({
        type: "file",
        source: activeSource,
        callback: async (paths) => {
          try {
            const path = Array.isArray(paths) ? paths[0] : paths;
            const response = await fetch(path);
            const text = await response.text();
            const parsed = AoN.parse(text);
            AoN.lastParsed = parsed;

            await AoN.compileMatches(parsed, { retrieveDocument: false });
            resolve({ path, parsed, matches: AoN.matches });
          } catch (e) {
            ui.notifications?.error?.("AoN Import: failed to load file");
            resolve(null);
          }
        },
      }).render(true);
    });
  };

  AoN.createMerchantFromMatches = async function ({
    actorName = "AoN Merchant",
  } = {}) {
    if (typeof game === "undefined" || !game.actors) {
      console.warn(
        "AoNImport: Foundry game.actors not available - cannot create Merchant Actor"
      );
      return null;
    }

    // Resolve matches from internal state
    const matchList = Object.values(AoN.matches).flat();

    // Try to create an actor of type 'loot' (PF2e). Fallback to 'npc' if not available.
    let actorType = "loot";
    let actor = null;
    try {
      actor = await Actor.implementation.createDocuments([
        { name: actorName, type: actorType },
      ]);
      actor = actor[0];
    } catch (err) {
      console.warn(
        'AoNImport: failed to create actor of type "loot", falling back to "npc"',
        err
      );
      actorType = "npc";
      try {
        actor = await Actor.create({ name: actorName, type: actorType });
      } catch (err2) {
        console.error(
          "AoNImport: failed to create actor for merchant import",
          err2
        );
        ui.notifications?.error?.(
          "AoN Import: failed to create Merchant Actor"
        );
        return null;
      }
    }

    // Create embedded items on the actor in a single batch
    try {
      if (matchList.length > 0) {
        // Use createEmbeddedDocuments where available (Foundry v9+), otherwise createOwnedItem
        if (typeof actor.createEmbeddedDocuments === "function") {
          await actor.createEmbeddedDocuments("Item", matchList);
        } else if (typeof actor.createOwnedItem === "function") {
          for (const it of matchList) await actor.createOwnedItem(it);
        }
      }
    } catch (err) {
      console.error("AoNImport: failed to add items to Merchant Actor", err);
      ui.notifications?.error?.(
        "AoN Import: failed to populate Merchant Actor items"
      );
    }

    return actor;
  };
})(this);
