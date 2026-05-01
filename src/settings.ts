import {App, PluginSettingTab, Setting} from "obsidian";
import ImageImporterPlugin from "./main";
import { clampQuality } from "utilityFunctions";

export interface ImageImporterSettings {
	templateFolder: string;
	imageFolder: string;
	notesFolder: string;
	defaultCompress: boolean;
	defaultQuality: number;       // 1–100
}

export const DEFAULT_SETTINGS: ImageImporterSettings = {
	templateFolder: "Templates",
	imageFolder: "Assets/Images",
	notesFolder: "",
	defaultCompress: false,
	defaultQuality: 60,
};

export class ImageImporterSettingTab extends PluginSettingTab {
	plugin: ImageImporterPlugin;

	constructor(app: App, plugin: ImageImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Image Importer Settings" });

		new Setting(containerEl)
			.setName("Template folder")
			.setDesc("Folder containing .md templates (e.g. Templates)")
			.addText(t => t.setPlaceholder("Templates")
				.setValue(this.plugin.settings.templateFolder)
				.onChange(async v => { this.plugin.settings.templateFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Image destination folder")
			.setDesc("Where imported images are copied inside your vault")
			.addText(t => t.setPlaceholder("Assets/Images")
				.setValue(this.plugin.settings.imageFolder)
				.onChange(async v => { this.plugin.settings.imageFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Notes destination folder")
			.setDesc("Where new notes are created (blank = vault root)")
			.addText(t => t.setPlaceholder("(vault root)")
				.setValue(this.plugin.settings.notesFolder)
				.onChange(async v => { this.plugin.settings.notesFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Compress by default")
			.setDesc("Pre-tick the compression checkbox when the importer opens")
			.addToggle(t => t.setValue(this.plugin.settings.defaultCompress)
				.onChange(async v => { this.plugin.settings.defaultCompress = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Default JPEG quality")
			.setDesc("1 (smallest) – 100 (best). Used when compression is enabled.")
			.addText(t => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.inputEl.max = "100";
				t.setPlaceholder("60")
					.setValue(String(this.plugin.settings.defaultQuality))
					.onChange(async v => {
						const n = clampQuality(parseInt(v));
						this.plugin.settings.defaultQuality = n;
						await this.plugin.saveSettings();
					});
			});
	}
}
