// AoN Import library: parse AoN CSV / JSON exports and normalize records

(function(global) {
  const AoNImport = {
    // Parse CSV text into array of objects using header row
    parseCSV(csvText) {
      if (typeof csvText !== 'string') throw new TypeError('CSV input must be a string');
      const rows = [];
      let cur = '';
      let row = [];
      let inQuotes = false;
      for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i+1];
        if (ch === '"') {
          if (inQuotes && next === '"') { // escaped quote
            cur += '"';
            i++; // skip next
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          row.push(cur);
          cur = '';
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
          // handle CRLF and LF
          if (cur !== '' || row.length > 0) {
            row.push(cur);
            rows.push(row);
            row = [];
            cur = '';
          }
          // skip extra \n after \r
          if (ch === '\r' && next === '\n') i++;
        } else {
          cur += ch;
        }
      }
      if (cur !== '' || row.length > 0) {
        row.push(cur);
        rows.push(row);
      }

      if (rows.length === 0) return [];

      // Use first row as header
      const header = rows[0].map(h => (h || '').trim());
      const out = [];
      for (let r = 1; r < rows.length; r++) {
        const rec = {};
        const cols = rows[r];
        for (let c = 0; c < header.length; c++) {
          const key = header[c] || (`field${c}`);
          rec[key] = cols[c] !== undefined ? cols[c].trim() : '';
        }
        out.push(rec);
      }
      return out;
    },

    // Parse AoN JSON (either string or parsed object)
    parseJSON(json) {
      let obj;
      if (typeof json === 'string') {
        obj = JSON.parse(json);
      } else {
        obj = json;
      }
      // AoN exports may provide an array or an object with an items array
      if (Array.isArray(obj)) return obj.map(item => this.normalizeRecord(item));
      if (obj && Array.isArray(obj.items)) return obj.items.map(item => this.normalizeRecord(item));
      // Fallback: if it's an object with keys representing records, map values
      if (obj && typeof obj === 'object') return Object.values(obj).map(item => this.normalizeRecord(item));
      return [];
    },

    // Normalize a single record (object with arbitrary keys) into standard internal shape
    normalizeRecord(record) {
      if (!record || typeof record !== 'object') return null;
      const r = {};
      const getField = (names) => {
        for (const n of names) {
          if (n in record && record[n] !== null && record[n] !== undefined && String(record[n]).trim() !== '') return record[n];
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

      r.name = getField(['name','Name','item_name','title']) || '';
      r.type = getField(['type','Type','item_type']) || '';
      r.description = getField(['description','Description','desc','text']) || '';
      r.source = getField(['source','Source']) || '';
      r.quantity = parseInt(getField(['quantity','qty','Quantity']) || getField(['count']) || 1, 10) || 1;

      // Price parsing: handle strings like "12 gp" or "12.5"
      const priceRaw = getField(['price','Price','cost','Cost']);
      r.price = null;
      if (priceRaw !== undefined && priceRaw !== null && String(priceRaw).trim() !== '') {
        let p = String(priceRaw).trim();
        // remove currency abbreviations and non-numeric except . and , and -
        p = p.replace(/[^0-9.,-]/g, '');
        // If contains comma and dot, assume comma thousands -> remove commas
        if (p.indexOf(',') !== -1 && p.indexOf('.') !== -1) p = p.replace(/,/g, '');
        // If only commas present, replace commas with dot for decimal
        else if (p.indexOf(',') !== -1) p = p.replace(/,/g, '.');
        const f = parseFloat(p);
        if (!Number.isNaN(f)) r.price = f;
      }

      // Level parsing
      r.level = null;
      const lvl = getField(['level','Level','item_level']);
      if (lvl !== undefined && lvl !== null && String(lvl).trim() !== '') {
        const n = parseInt(String(lvl).replace(/[^0-9-]/g, ''), 10);
        if (!Number.isNaN(n)) r.level = n;
      }

      // Bulk and weight
      r.bulk = getField(['bulk','Bulk','weight','Weight']) || '';

      // Traits / categories
      let traitsRaw = getField(['traits','Traits','tags','Categories','category']);
      if (traitsRaw === undefined || traitsRaw === null) traitsRaw = '';
      if (Array.isArray(traitsRaw)) r.traits = traitsRaw.map(t => String(t).trim()).filter(Boolean);
      else if (typeof traitsRaw === 'string') {
        r.traits = traitsRaw.split(/[,;|\/]+/).map(t => t.trim()).filter(Boolean);
      } else r.traits = [];

      // Keep original record for reference
      r.raw = record;

      return r;
    },

    // Auto-detect input type and parse accordingly. `input` can be string (CSV/JSON) or object
    parse(input) {
      if (input == null) return [];
      if (typeof input === 'string') {
        const s = input.trim();
        if (s.startsWith('{') || s.startsWith('[')) {
          // JSON
          try {
            return this.parseJSON(JSON.parse(s));
          } catch (e) {
            throw new Error('Invalid JSON provided to AoNImport.parse');
          }
        } else {
          // treat as CSV
          const arr = this.parseCSV(s);
          return arr.map(item => this.normalizeRecord(item));
        }
      }
      if (Array.isArray(input)) return input.map(i => this.normalizeRecord(i));
      if (typeof input === 'object') {
        // try parseJSON behavior
        return this.parseJSON(input);
      }
      return [];
    }
      ,

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
        if (typeof game === 'undefined' || !game.packs) return out;

        const packs = Array.from(game.packs.values());
        for (const pack of packs) {
          try {
            const meta = pack.metadata || {};
            // Only search PF2e system packs
            if (meta.system !== 'pf2e') continue;

            const index = await pack.getIndex();
            // Normalize index values into an array of entries
            const idxValues = (index && typeof index.values === 'function') ? Array.from(index.values()) : (Array.isArray(index) ? index : []);
            for (const entry of idxValues) {
              const entryName = String(entry.name || entry?.data?.name || '').trim().toLowerCase();
              if (entryName === queryName) {
                const match = {
                  pack: pack.collection,
                  packLabel: meta.label || pack.collection,
                  id: entry._id || entry.id || entry._key || null,
                  name: entry.name || entry?.data?.name || '',
                  type: entry.type || entry?.data?.type || null
                };
                if (options.retrieveDocument) {
                  try {
                    const docId = match.id;
                    if (docId) {
                      // Prefer pack.getDocument, fallback to getEntity/get
                      if (typeof pack.getDocument === 'function') {
                        match.document = await pack.getDocument(docId);
                      } else if (typeof pack.get === 'function') {
                        match.document = await pack.get(docId);
                      }
                    }
                  } catch (e) {
                    console.warn('AoNImport: failed to retrieve document from pack', pack.collection, e);
                  }
                }
                out.push(match);
              }
            }
          } catch (err) {
            // Non-fatal: continue searching other packs
            // eslint-disable-next-line no-console
            console.warn('AoNImport: error searching pack', pack.collection, err);
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
      }
  };

  // Expose globally
  global.AoNImport = AoNImport;
})(this);

// Add UI helper to open a file picker (Foundry FilePicker or browser file input)
(function(global) {
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
  AoN.openImportDialog = async function({ compile = false, retrieveDocument = false } = {}) {
    // If Foundry's FilePicker is available, use it to select server-side files
    if (typeof FilePicker !== 'undefined') {
      return new Promise((resolve) => {
        const fp = new FilePicker({
          type: 'file',
          callback: async (paths) => {
            try {
              // FilePicker returns a string path for single selection
              const path = Array.isArray(paths) ? paths[0] : paths;
              const response = await fetch(path);
              const text = await response.text();
              const parsed = AoN.parse(text);
              AoN.lastParsed = parsed;
              if (compile) await AoN.compileMatches(parsed, { retrieveDocument });
              resolve({ path, parsed, matches: AoN.matches });
            } catch (e) {
              ui.notifications?.error?.('AoN Import: failed to load file');
              resolve(null);
            }
          }
        }).render(true);
      });
    }

    // Browser fallback: create a hidden file input
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,application/json,text/csv,text/plain,.json';
      input.style.display = 'none';
      input.onchange = async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return resolve(null);
        try {
          const text = await readFileAsText(file);
          const parsed = AoN.parse(text);
          AoN.lastParsed = parsed;
          if (compile) await AoN.compileMatches(parsed, { retrieveDocument });
          resolve({ fileName: file.name, parsed, matches: AoN.matches });
        } catch (e) {
          console.error('AoNImport: file read error', e);
          resolve(null);
        } finally {
          input.remove();
        }
      };
      document.body.appendChild(input);
      input.click();
    });
  };
})(this);


