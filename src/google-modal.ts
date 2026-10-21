import { App, Modal, Notice, Setting } from "obsidian";
import { GoogleEventForm } from "./google";

// Form di modifica di un evento Google esistente.
export class EditGoogleEventModal extends Modal {
  constructor(
    app: App,
    private form: GoogleEventForm,
    private recurring: boolean,
    private onSave: (f: GoogleEventForm) => Promise<void>,
    private onDelete: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const f = this.form;
    this.titleEl.setText("Modifica evento Google");
    if (this.recurring) {
      contentEl.createEl("p", {
        text: "Evento ricorrente: la modifica o l'eliminazione vale solo per questa occorrenza.",
        cls: "mod-warning",
      });
    }

    new Setting(contentEl).setName("Titolo").addText((t) => t.setValue(f.title).onChange((v) => (f.title = v)));
    new Setting(contentEl).setName("Data").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(f.date).onChange((v) => (f.date = v));
    });
    new Setting(contentEl).setName("Data fine (opzionale, più giorni)").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(f.endDate).onChange((v) => (f.endDate = v));
    });
    let timeBox: HTMLElement;
    new Setting(contentEl).setName("Tutto il giorno").addToggle((t) =>
      t.setValue(f.allDay).onChange((v) => {
        f.allDay = v;
        timeBox.style.display = v ? "none" : "";
      }),
    );
    timeBox = contentEl.createDiv();
    timeBox.style.display = f.allDay ? "none" : "";
    new Setting(timeBox).setName("Ora inizio").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(f.startTime).onChange((v) => (f.startTime = v));
    });
    new Setting(timeBox).setName("Ora fine").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(f.endTime).onChange((v) => (f.endTime = v));
    });
    new Setting(contentEl).setName("Luogo").addText((t) => t.setValue(f.location).onChange((v) => (f.location = v)));
    new Setting(contentEl).setName("Descrizione").addTextArea((t) =>
      t.setValue(f.description).onChange((v) => (f.description = v)),
    );

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Salva").setCta().onClick(async () => {
          if (!f.title.trim()) return new Notice("Titolo mancante");
          if (!f.date) return new Notice("Data mancante");
          if (f.endDate && f.endDate < f.date) return new Notice("Data fine prima di data inizio");
          try {
            await this.onSave(f);
            this.close();
          } catch (e) {
            new Notice(`Salvataggio fallito: ${(e as Error).message}`, 8000);
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Elimina").setWarning().onClick(async () => {
          if (!window.confirm(`Eliminare «${f.title}» da Google Calendar?`)) return;
          try {
            await this.onDelete();
            this.close();
          } catch (e) {
            new Notice(`Eliminazione fallita: ${(e as Error).message}`, 8000);
          }
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
