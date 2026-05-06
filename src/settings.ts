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
		new Setting(containerEl).setHeading().setName("Image importer settings");

		new Setting(containerEl)
			.setName("Template folder")
			.setDesc("Folder inside your vault where templates are stored.")
			.addText(t => t.setPlaceholder("Templates")
				.setValue(this.plugin.settings.templateFolder)
				.onChange(async v => { this.plugin.settings.templateFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Image destination folder")
			.setDesc("Where imported images are stored inside your vault. Leave blank for your vault's root.")
			.addText(t => t.setPlaceholder("Assets/images")
				.setValue(this.plugin.settings.imageFolder)
				.onChange(async v => { this.plugin.settings.imageFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Notes destination folder")
			.setDesc("Where new notes are created. Leave blank for your vault's root.")
			.addText(t => t.setPlaceholder("(vault root)")
				.setValue(this.plugin.settings.notesFolder)
				.onChange(async v => { this.plugin.settings.notesFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Compress by default")
			.setDesc("Pre-select the compression checkbox when the importer opens.")
			.addToggle(t => t.setValue(this.plugin.settings.defaultCompress)
				.onChange(async v => { this.plugin.settings.defaultCompress = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Default JPEG quality")
			.setDesc("1 (lowest) – 100 (highest). Only matters when compression is enabled.")
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
