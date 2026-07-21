import {
	App,
	Modal,
	Notice,
	Plugin,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { ImageImporterSettings, DEFAULT_SETTINGS, ImageImporterSettingTab } from "./settings";
import { formatBytes, clampQuality } from "./utilityFunctions";



// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class ImageImporterPlugin extends Plugin {
	settings!: ImageImporterSettings;

	async onload() {
		await this.loadSettings();
		this.addRibbonIcon("image-plus", "Bulk image to file importer", () => {
			new ImageImportModal(this.app, this).open();
		});
		this.addCommand({
			id: "open-image-importer",
			name: "Import",
			callback: () => new ImageImportModal(this.app, this).open(),
		});
		this.addSettingTab(new ImageImporterSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ImageImporterSettings>
		);
	}
	async saveSettings() { await this.saveData(this.settings); }

	// ── Templates ──────────────────────────────────────────────────────────────

	getTemplates(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(this.settings.templateFolder)
		);
		if (!folder || !(folder instanceof TFolder)) return [];
		const out: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (c instanceof TFile && c.extension === "md") out.push(c);
				else if (c instanceof TFolder) walk(c);
			}
		};
		walk(folder);
		return out;
	}

	async readTemplate(file: TFile): Promise<string> {
		return this.app.vault.read(file);
	}

	// ── Image processing ───────────────────────────────────────────────────────

	/** Compress a browser File to JPEG via an off-screen Canvas. quality 1–100. */
	async compressToJpeg(
		file: File,
		quality: number
	): Promise<{ buffer: ArrayBuffer; ext: "jpg" }> {
		const q = Math.max(1, Math.min(100, quality)) / 100;
		const url = URL.createObjectURL(file);
		const img = await new Promise<HTMLImageElement>((res, rej) => {
			const el = new Image();
			el.onload = () => res(el);
			el.onerror = () => rej(new Error(`Cannot decode ${file.name}`));
			el.src = url;
		});
		URL.revokeObjectURL(url);

		const canvas = document.createElement("canvas");
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D unavailable");
		ctx.drawImage(img, 0, 0);

		const blob = await new Promise<Blob>((res, rej) =>
			canvas.toBlob(
				b => b ? res(b) : rej(new Error("toBlob returned null")),
				"image/jpeg", q
			)
		);
		return { buffer: await blob.arrayBuffer(), ext: "jpg" };
	}

	// ── Vault helpers ──────────────────────────────────────────────────────────

	async ensureFolder(path: string) {
		const p = normalizePath(path);
		if (!this.app.vault.getAbstractFileByPath(p))
			await this.app.vault.createFolder(p);
	}

	// ── Core import ────────────────────────────────────────────────────────────

	async importImages(
		entries: ImportEntry[],
		templateContent: string,
		compress: boolean,
		quality: number,
		fileToAddTo: TFile | null,
		onProgress?: (i: number, total: number, label: string) => void
	): Promise<{ success: number; errors: string[]; savedBytes: number }> {
		const results = { success: 0, errors: [] as string[], savedBytes: 0 };
		const today = new Date().toISOString().split("T")[0];

		// If adding to existing file, read current content
		let existingFileContent = "";
		if (fileToAddTo) {
			existingFileContent = await this.app.vault.read(fileToAddTo);
		}

		for (let i = 0; i < entries.length; i++) {
			const { file, imageBaseName, noteTitle } = entries[i]!;
			onProgress?.(i, entries.length, file.name);

			try {
				let buffer: ArrayBuffer = await file.arrayBuffer();
				let ext: string = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
				const originalSize = file.size;

				// Compress / convert to JPEG
				// We need a File object for compressToJpeg; wrap buffer if bg was removed
				if (compress) {
					const result = await this.compressToJpeg(file, quality);
					buffer = result.buffer;
					ext = result.ext;
				}

				results.savedBytes += originalSize - buffer.byteLength;

				// Final image filename uses the user-edited imageBaseName
				const savedFilename = `${imageBaseName}.${ext}`;

				// Write image
				const imgFolder = normalizePath(this.settings.imageFolder);
				await this.ensureFolder(imgFolder);
				const imgPath = normalizePath(`${imgFolder}/${savedFilename}`);
				if (!this.app.vault.getAbstractFileByPath(imgPath))
					await this.app.vault.createBinary(imgPath, buffer);

				// Build embed link
				const embedLink = `![[${savedFilename}]]`;
				const wikiLink = `"[[${savedFilename}]]"`;

				if (fileToAddTo) {
					// Add to existing file
					existingFileContent += `\n\n${embedLink}`;
				} else {
					// Create new note from template
					const templateInput: string = templateContent;

					let noteContent: string = templateInput
						.replace(/^(image:\s*)$/m, `$1 ${wikiLink}`)
						.replace(/\{\{date\}\}/gi, today!);

					// const noteContent_4: string = noteContent_1
					// 	.replace(/\{\{image\}\}/gi, (_m, offset, str) => {
					// 		const fmEnd: number = str.indexOf("---", 3);
					// 		return offset < fmEnd ? wikiLink : embedLink;
					// 	})

					// const noteContent_5: string = noteContent_1
					// let noteContent: string = noteContent_5;

					// Ensure embed in body
					const fmEnd = noteContent.indexOf("---", 3);
					const body = fmEnd > -1 ? noteContent.slice(fmEnd + 3) : noteContent;
					if (!body.includes("![[")) {
						const at = fmEnd > -1 ? fmEnd + 3 : 0;
						noteContent =
							noteContent.slice(0, at) + `\n${embedLink}\n` + noteContent.slice(at);
					}

					// Write note
					const notesFolder = normalizePath(this.settings.notesFolder || "");
					if (notesFolder) await this.ensureFolder(notesFolder);
					const notePath = normalizePath(
						`${notesFolder ? notesFolder + "/" : ""}${noteTitle}.md`
					);
					if (this.app.vault.getAbstractFileByPath(notePath)) {
						results.errors.push(`Note already exists: ${noteTitle}.md`);
						continue;
					}
					await this.app.vault.create(notePath, noteContent);
				}
				results.success++;
			} catch (e) {
				results.errors.push(`${file.name}: ${(e as Error).message}`);
			}
		}

		// Write updated content to file if adding to existing
		if (fileToAddTo) {
			await this.app.vault.modify(fileToAddTo, existingFileContent);
		}

		onProgress?.(entries.length, entries.length, "");
		return results;
	}
}

// ─── Types shared between plugin and modal ────────────────────────────────────

interface ImportEntry {
	file: File;
	imageBaseName: string;   // final image filename (no ext), user-editable
	noteTitle: string;   // final note title, user-editable
}

// ─── Modal ────────────────────────────────────────────────────────────────────

class ImageImportModal extends Modal {
	plugin: ImageImporterPlugin;
	selectedFiles: File[] = [];
	selectedTemplate: TFile | null = null;
	selectedFileToAddTo: TFile | null = null;

	// Per-row state — keyed by file.name (stable)
	imageNameMap: Map<string, string> = new Map(); // file.name → imageBaseName
	noteNameMap: Map<string, string> = new Map(); // file.name → noteTitle

	// Options
	compress = false;
	quality = 60;

	private previewDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: ImageImporterPlugin) {
		super(app);
		this.plugin = plugin;
		this.compress = plugin.settings.defaultCompress;
		this.quality = plugin.settings.defaultQuality;
	}

	onOpen() {
		const { contentEl } = this;
		// Resize the Obsidian modal container
		if (contentEl.parentElement) {
			contentEl.parentElement.addClass("image-importer-modal-parent");
		}
		contentEl.empty();
		contentEl.addClass("image-importer-modal");
		contentEl.createEl("h1", { text: "Import images as notes" });

				// ── 1. Image picker ────────────────────────────────────────────────────
		const helperText: string = "PNG · JPG · WEBP · GIF supported";
		contentEl.createEl("h2", { text: "Step 1: select  📸" });
		const dropZone = contentEl.createDiv({ cls: "image-importer-dropzone" });
		dropZone.createEl("p", { text: "Drop images here or click to browse" });
		dropZone.createEl("p", { text: helperText, cls: "image-importer-hint" });

		const fileInput = contentEl.createEl("input", { type: "file", cls: "image-importer-hidden-input" });
		fileInput.multiple = true;
		fileInput.accept = "image/*";

		dropZone.addEventListener("click", () => fileInput.click());
		dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.addClass("drag-over"); });
		dropZone.addEventListener("dragleave", () => dropZone.removeClass("drag-over"));
		dropZone.addEventListener("drop", e => {
			e.preventDefault(); dropZone.removeClass("drag-over");
			if (e.dataTransfer?.files) handleFiles(Array.from(e.dataTransfer.files));
		});
		fileInput.addEventListener("change", () => {
			if (fileInput.files) handleFiles(Array.from(fileInput.files));
		});

		const fileListEl = contentEl.createDiv({ cls: "image-importer-filelist" });

		// ── 2. Options ────────────────────────────────────────────────────────
				// ── 3. Options (compression + bg removal) ─────────────────────────────
		contentEl.createEl("h2", { text: "Step 2: select options 📋" });
		const optionsBox = contentEl.createDiv({ cls: "image-importer-options-box" });

		// — Compression —
		const compressRow = optionsBox.createDiv({ cls: "image-importer-option-row" });
		const compCb = compressRow.createEl("input", { type: "checkbox" });
		compCb.id = "img-compress-toggle";
		compCb.checked = this.compress;
		const compLabel = compressRow.createEl("label", { text: "Convert to JPEG and compress" });
		compLabel.htmlFor = "img-compress-toggle";

		// Quality integer input (shown when compress is on)
		const qualityRow = optionsBox.createDiv({ cls: "image-importer-quality-row" });
		if (!this.compress) qualityRow.addClass("hidden");
		qualityRow.createEl("label", { text: "Quality (1–100)", cls: "image-importer-quality-label" });
		const qualityInput = qualityRow.createEl("input", { type: "number" });
		qualityInput.min = "1";
		qualityInput.max = "100";
		qualityInput.value = String(this.quality);
		qualityInput.addClass("image-importer-quality-input");
		qualityRow.createEl("span", { text: "Lower = smaller file, more artifacts.", cls: "image-importer-hint" });

		compCb.addEventListener("change", () => {
			this.compress = compCb.checked;
			if (this.compress) qualityRow.removeClass("hidden");
			else qualityRow.addClass("hidden");
			if (this.selectedFiles.length > 0) schedulePreview();
		});
		qualityInput.addEventListener("change", () => {
			this.quality = clampQuality(parseInt(qualityInput.value) || this.quality);
			qualityInput.value = String(this.quality);
			if (this.compress && this.selectedFiles.length > 0) schedulePreview();
		});
		qualityInput.addEventListener("input", () => {
			const v = parseInt(qualityInput.value);
			if (!isNaN(v)) {
				this.quality = clampQuality(v);
				schedulePreview();
			}
		});

		// Divider
		// optionsBox.createEl("hr", { cls: "image-importer-divider" });


		contentEl.createEl("h3", { text: "Create a note from a template" });
		contentEl.createEl("p", { text: "- Your template *must* have a property named 'image' and be of type text.", cls: "image-importer-hint" });
		contentEl.createEl("p", { text: "- Option 1 & 2 do not work together. Option 1 will be ignored if option 2 is selected.", cls: "image-importer-hint" });

		const templates = this.plugin.getTemplates();
		if (templates.length === 0) {
			contentEl.createEl("p", {
				text: `No templates found in "${this.plugin.settings.templateFolder}". Check your settings.`,
				cls: "image-importer-warning",
			});
		}

		// Template selection
		contentEl.createEl("label", { text: "Template:", cls: "image-importer-section-label" });
		const templateSelect = contentEl.createEl("select", { cls: "image-importer-select" });
		templateSelect.createEl("option", { value: "", text: "Select a template" });
		templates.forEach(t =>
			templateSelect.createEl("option", { value: t.path, text: t.basename })
		);
		templateSelect.addEventListener("change", () => {
			const templateFile = this.app.vault.getAbstractFileByPath(templateSelect.value);
			this.selectedTemplate = templateFile instanceof TFile ? templateFile : null;
			if (this.selectedTemplate) this.selectedFileToAddTo = null;
			updateImportButton();
		});

		// Divider
		// contentEl.createEl("hr", { cls: "image-importer-divider" });

		// File search
		contentEl.createEl("h3", { text: "Append images to an existing note" });
		contentEl.createEl("label", { text: "Search for a file:", cls: "image-importer-section-label" });
		const fileSearchContainer = contentEl.createDiv({ cls: "image-importer-file-search" });
		const fileSearchInput = fileSearchContainer.createEl("input", {
			type: "text",
			placeholder: "Search files in vault...",
			cls: "image-importer-file-search-input",
		}); //as HTMLInputElement;

		const fileResultsList = fileSearchContainer.createDiv({ cls: "image-importer-file-results" });
		let searchTimeout: ReturnType<typeof setTimeout> | null = null;

		fileSearchInput.addEventListener("input", (): void => {
			if (searchTimeout) clearTimeout(searchTimeout);
			const query = fileSearchInput.value.trim().toLowerCase();

			if (query.length === 0) {
				fileResultsList.empty();
				return;
			}

			searchTimeout = setTimeout(() => {
				fileResultsList.empty();
				const allFiles: TFile[] = [];
				const walk = (folder: TFolder) => {
					for (const child of folder.children) {
						if (child instanceof TFile && child.extension === "md") allFiles.push(child);
						else if (child instanceof TFolder) walk(child);
					}
				};
				walk(this.app.vault.getRoot());

				const matches: TFile[] = allFiles
					.filter(f => f.path.toLowerCase().includes(query))
					.slice(0, 10);

				if (matches.length === 0) {
					fileResultsList.createEl("div", { text: "No files found.", cls: "image-importer-file-result-empty" });
					return;
				}

				matches.forEach(f => {
					const resultItem = fileResultsList.createDiv({ cls: "image-importer-file-result" });
					resultItem.createEl("span", { text: f.path, cls: "image-importer-file-result-text" });
					resultItem.addEventListener("click", (): void => {
						this.selectedFileToAddTo = f;
						this.selectedTemplate = null;
						templateSelect.value = "";
						fileSearchInput.value = f.path;
						fileResultsList.empty();
						updateImportButton();
					});
				});
			}, 300);
		});

		contentEl.createEl("hr", { cls: "image-importer-divider" });

		// ── 4. Name review table ───────────────────────────────────────────────
		const nameSection = contentEl.createDiv({ cls: "image-importer-name-section hidden" });
		nameSection.createEl("h2", { text: "Step 3: review filenames & note titles 📝" });

		// Bulk rename toolbar
		const bulkRow = nameSection.createDiv({ cls: "image-importer-bulk-row" });
		const bulkInput = bulkRow.createEl("input", {
			type: "text",
			placeholder: "Base name e.g. Italy-pics_day_one",
			cls: "image-importer-bulk-input",
		});
		const applyImageBtn = bulkRow.createEl("button", {
			text: "Apply to image names",
			cls: "image-importer-bulk-btn",
		});
		const applyNoteBtn = bulkRow.createEl("button", {
			text: "Apply to note titles",
			cls: "image-importer-bulk-btn",
		});
		bulkRow.createEl("span", {
			text: "Appends _1, _2 … to each row",
			cls: "image-importer-hint",
		});

		// Table
		const tableWrapper = nameSection.createDiv({ cls: "image-importer-table-wrapper" });
		const nameTable = tableWrapper.createEl("table", { cls: "image-importer-table" });
		const thead = nameTable.createEl("thead");
		const hrow = thead.createEl("tr");
		hrow.createEl("th", { text: "Original file" });
		hrow.createEl("th", { text: "Image filename" });
		hrow.createEl("th", { text: "Size" });
		hrow.createEl("th", { text: "Note title" });
		const tbody = nameTable.createEl("tbody");

		// Bulk apply handlers
		applyImageBtn.addEventListener("click", () => {
			const base = bulkInput.value.trim();
			if (!base) { new Notice("Enter a base name first."); return; }
			this.selectedFiles.forEach((f, idx) => {
				const newName = `${base}_${idx + 1}`;
				this.imageNameMap.set(f.name, newName);
				const input = tbody.querySelector<HTMLInputElement>(
					`tr[data-file="${CSS.escape(f.name)}"] .img-name-input`
				);
				if (input) input.value = newName;
			});
		});

		applyNoteBtn.addEventListener("click", () => {
			const base = bulkInput.value.trim();
			if (!base) { new Notice("Enter a base name first."); return; }
			this.selectedFiles.forEach((f, idx) => {
				const newName = `${base}_${idx + 1}`;
				this.noteNameMap.set(f.name, newName);
				const input = tbody.querySelector<HTMLInputElement>(
					`tr[data-file="${CSS.escape(f.name)}"] .note-name-input`
				);
				if (input) input.value = newName;
			});
		});

		// ── Import button + progress ───────────────────────────────────────────
		const buttonRow = contentEl.createDiv({ cls: "image-importer-buttons" });
		const progressEl = buttonRow.createDiv({ cls: "image-importer-progress hidden" });
		const importBtn = buttonRow.createEl("button", { text: "Import", cls: "mod-cta" });
		importBtn.disabled = true;

		// ── Helpers ────────────────────────────────────────────────────────────

		const updateImportButton = () => {
			importBtn.disabled = this.selectedFiles.length === 0 || (!this.selectedTemplate && !this.selectedFileToAddTo);
		};

		const schedulePreview = (): void => {
			if (this.previewDebounce) clearTimeout(this.previewDebounce);
			this.previewDebounce = setTimeout((): void => { void refreshSizePreviews(); }, 450);
		};

		const refreshSizePreviews = async () => {
			for (const f of this.selectedFiles) {
				const cell = tbody.querySelector<HTMLElement>(
					`tr[data-file="${CSS.escape(f.name)}"] .size-cell`
				);
				if (!cell) continue;

				if (!this.compress) {
					cell.textContent = formatBytes(f.size);
					cell.className = "size-cell";
					continue;
				}

				cell.textContent = "Estimating…";
				cell.className = "size-cell size-estimating";

				try {
					const { buffer } = await this.plugin.compressToJpeg(f, this.quality);
					const ns = buffer.byteLength;
					const pct = Math.round((1 - ns / f.size) * 100);
					cell.textContent = ns < f.size
						? `${formatBytes(ns)} (−${pct}%)`
						: `${formatBytes(ns)} (+${Math.abs(pct)}%)`;
					cell.className = "size-cell " + (ns < f.size ? "size-smaller" : "size-larger");
				} catch {
					cell.textContent = "Preview failed";
					cell.className = "size-cell size-error";
				}
			}
		};

		const handleFiles = (files: File[]): void => {
			const imgs = files.filter(f => f.type.startsWith("image/"));
			if (imgs.length === 0) { new Notice("No image files detected."); return; }

			this.selectedFiles = imgs;
			fileListEl.empty();
			tbody.empty();
			this.imageNameMap.clear();
			this.noteNameMap.clear();

			for (const f of imgs) {
				// Pill
				const pill = fileListEl.createDiv({ cls: "image-importer-pill" });
				pill.createEl("span", { text: f.name });
				const rm = pill.createEl("button", { text: "×" });
				rm.addEventListener("click", () => {
					this.selectedFiles = this.selectedFiles.filter(x => x !== f);
					pill.remove();
					tbody.querySelectorAll(`tr[data-file="${CSS.escape(f.name)}"]`).forEach(r => r.remove());
					this.imageNameMap.delete(f.name);
					this.noteNameMap.delete(f.name);
					if (this.selectedFiles.length === 0) nameSection.addClass("hidden");
					else nameSection.removeClass("hidden");
					updateImportButton();
				});

				const origBase = f.name.replace(/\.[^/.]+$/, "");
				this.imageNameMap.set(f.name, origBase);
				this.noteNameMap.set(f.name, origBase);

				const row = tbody.createEl("tr");
				row.dataset.file = f.name;

				// Col 1: original filename (read-only label)
				row.createEl("td", { text: f.name, cls: "orig-file-cell" });

				// Col 2: editable image filename
				const imgCell = row.createEl("td");
				const imgInput = imgCell.createEl("input", {
					type: "text",
					value: origBase,
					cls: "image-importer-name-input img-name-input",
				});
				imgInput.addEventListener("input", () => {
					this.imageNameMap.set(f.name, imgInput.value.trim() || origBase);
				});

				// Col 3: size preview
				const sizeCell = row.createEl("td");
				sizeCell.addClass("size-cell");
				sizeCell.textContent = formatBytes(f.size);

				// Col 4: editable note title
				const noteCell = row.createEl("td");
				const noteInput = noteCell.createEl("input", {
					type: "text",
					value: origBase,
					cls: "image-importer-name-input note-name-input",
				});
				noteInput.addEventListener("input", () => {
					this.noteNameMap.set(f.name, noteInput.value.trim() || origBase);
				});
			}

			nameSection.removeClass("hidden");
			updateImportButton();
			if (this.compress) refreshSizePreviews().catch((err) => {
				console.error("Well, this is slightly embarrassing... But I hope you are able to see what the issue is from this error. Hint: this was fired from the 'refreshSizePreviews()' method.\n\n", err);
			});;
		};

		// ── Import ─────────────────────────────────────────────────────────────
		importBtn.addEventListener("click", () => {
			void (async (): Promise<void> => {
				if (!this.selectedTemplate && !this.selectedFileToAddTo) {
					new Notice("Please select a template or file first.");
					return;
				}

				if (this.selectedFiles.length === 0) {
					new Notice("Please select at least one image.");
					return;
				}

				importBtn.disabled = true;
				importBtn.textContent = "Importing...";
				progressEl.removeClass("hidden");
				progressEl.textContent = `0 / ${this.selectedFiles.length}`;

				let templateContent = "";
				if (this.selectedTemplate) {
					templateContent = await this.plugin.readTemplate(this.selectedTemplate);
				}

				const entries: ImportEntry[] = this.selectedFiles.map(f => ({
					file: f,
					imageBaseName: this.imageNameMap.get(f.name) || f.name.replace(/\.[^/.]+$/, ""),
					noteTitle: this.noteNameMap.get(f.name) || f.name.replace(/\.[^/.]+$/, ""),
				}));

				const results = await this.plugin.importImages(
					entries,
					templateContent,
					this.compress,
					this.quality,
					this.selectedFileToAddTo,
					(i, total, label) => {
						progressEl.textContent = label
							? `${i + 1} / ${total}: ${label}`
							: "Done";
					}
				);

				progressEl.addClass("hidden");

				const savedMsg =
					results.savedBytes > 0
						? ` Saved ${formatBytes(results.savedBytes)}.`
						: "";

				if (results.errors.length > 0) {
					new Notice(
						`Imported ${results.success} note(s).${savedMsg}\n` +
						`${results.errors.length} error(s):\n${results.errors.join("\n")}`,
						8000
					);
					importBtn.disabled = false;
					importBtn.textContent = "Import";
				} else {
					new Notice(`✓ Imported ${results.success} note(s).${savedMsg}`);
					this.close();
				}
			})();
		});
	}

	onClose() {
		if (this.previewDebounce) clearTimeout(this.previewDebounce);
		this.contentEl.empty();
	}
}