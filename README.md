## Calendario Vault

Vista calendario per [Obsidian Bases](https://help.obsidian.md/bases), con calendari Google e form per creare eventi.
Fork di [Calendar Bases](https://github.com/edrickleong/obsidian-calendar-bases) di Edrick Leong (MIT), basato su [FullCalendar](https://github.com/fullcalendar/fullcalendar).

![](./screenshot.png)

### Funzioni

- Vista Bases «Calendar»: mese, settimana con ore, settimana a giorni, giorno.
- Colori per evento (`Color by property` + mappa `valore=#hex`).
- Eventi con ora nelle fasce orarie; eventi senza ora o multi-giorno (`endDate`) nella riga «Tutto il giorno».
- Calendari esterni: Google Calendar (login OAuth con un client proprio; lettura, creazione, modifica, eliminazione) o indirizzo iCal segreto.
- Comando «Crea nuovo evento» (e icona nella barra laterale): sceglie il calendario, crea una nota per occorrenza (con ricorrenze) oppure un evento Google (ricorrenza come RRULE).
- Comando «Sincronizza promemoria iscrizione esami».

### Configurazione

Nelle impostazioni del plugin:
- **Calendari nota**: per ogni calendario nome, cartella delle note, file `.base`, tag, proprietà data e opzione Priorità/Completato. Servono al form «Nuovo evento».
- **Promemoria iscrizione esami**: cartella delle prove, cartella dei promemoria, prefisso, giorni prima. Disattivato di default.

### Installazione

Richiede Obsidian 1.10.0 o successivo.

Con [BRAT](obsidian://show-plugin?id=obsidian42-brat): «Add beta plugin», inserisci l'URL di questo repository, scegli l'ultima versione.

A mano: scarica `main.js`, `manifest.json`, `styles.css` dall'ultima release in `.obsidian/plugins/calendario-vault/`.

### Google Calendar

Servono un progetto Google Cloud con Calendar API abilitata e un client OAuth «Desktop». Inserisci Client ID e secret nelle impostazioni del plugin. Le credenziali restano in `data.json` (non sincronizzarlo e non metterlo in git).

### Sviluppo

```
npm install
npm run build
```

## Licenza

MIT. Copyright di Edrick Leong (Calendar Bases) e di Daniele Rubis.
