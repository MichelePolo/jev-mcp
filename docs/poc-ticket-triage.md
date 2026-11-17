# PoC: smistamento automatico dei ticket con un modello decisionale Jev-style

> Documento di proposta. I valori tra **[DA COMPLETARE]** vanno sostituiti con i dati reali del software di ticketing prima della presentazione. Le misure di latenza, consumi e accuratezza vengono da test effettivi su 12 ticket di esempio (vedi la [sezione 6](#6-consumo-di-risorse-performance-e-benchmark) e le appendici B e C): servono a dimostrare la fattibilità e a dimensionare l'hardware, non a stimare l'accuratezza in produzione.

## 1. Introduzione

Ogni ticket che arriva sul **software di ticketing** aziendale deve essere letto da un operatore per assegnargli una **categoria** e una **priorità** prima di poter essere lavorato. È un'attività ripetitiva, che rallenta la presa in carico e produce risultati diversi a seconda di chi la fa.

La proposta è affidare questo primo smistamento a un **modello decisionale** ("System One"), una classe di modelli AI diversa dai chatbot:

| | Chatbot (GPT, Claude…) | Modello decisionale (Jev, nimble…) |
| --- | --- | --- |
| Output | Testo libero | Una scelta tra opzioni **fisse**, con una **probabilità** |
| Latenza tipica | Secondi | Decimi di secondo |
| Verificabilità | Va interpretato | Un'etichetta e un numero, confrontabili con una soglia |
| Rischio di risposte inventate | Presente | Nullo: può scegliere solo tra le opzioni date |

**Jev** è il modello decisionale proprietario di TypeSafe ed è disponibile **solo come API cloud**. Sul nostro host useremo un modello aperto che parla **lo stesso protocollo** (`/v1/systemone`): **nimble** (9B parametri, licenza Apache 2.0), servito da **Ollama**. Il servizio di smistamento non sa quale modello c'è dietro. Passare a Jev in cloud o a un altro modello compatibile (es. CLM di Stanford/NVIDIA) richiede di cambiare **un URL**, non il codice.

**Obiettivo del PoC:** dimostrare su ticket reali che il modello assegna categoria e priorità con una concordanza con gli operatori sufficiente ad automatizzare la maggior parte dello smistamento, mantenendo i dati in azienda.

## 2. Architettura

```mermaid
flowchart LR
    U[Utente] -->|apre ticket| TK[(Software<br/>di ticketing)]
    TK -->|webhook o polling| T[Servizio<br/>ticket-triage]
    T -->|POST /v1/systemone<br/>categoria + priorità| O[Ollama<br/>modello nimble]
    O -->|probabilità| T
    T -->|confidenza ≥ soglia| A[Aggiorna ticket:<br/>categoria, priorità,<br/>nota con confidenza]
    T -->|confidenza < soglia| Q[Coda<br/>'Da smistare'<br/>per operatore]
    A --> TK
    Q --> TK
    T --> L[(Log decisioni<br/>per la valutazione)]

    subgraph Host aziendale
        T
        O
        L
    end
```

### Componenti

| Componente | Ruolo | Tecnologia |
| --- | --- | --- |
| **Software di ticketing** | Sistema esistente | Invariato. Servono un'API o un webhook per leggere i nuovi ticket e scrivere categoria/priorità **[DA COMPLETARE: API disponibili nel software di ticketing]** |
| **ticket-triage** | Riceve il ticket, chiede la decisione al modello, applica soglie e regole, aggiorna il ticket | Piccolo servizio Node.js/TypeScript. Riusa il client `/v1/systemone` già scritto e testato in `jev-mcp` |
| **Ollama + modello** | Calcola le probabilità per categoria e priorità | Ollama (testato con 0.40.3 e 0.40.4), modello `nimble` (9,5 GB) o `tev1` (4,6 GB, richiede Ollama ≥ 0.40.4): vedi sezione 6 |
| **Log decisioni** | Testo, decisione, confidenza, correzioni degli operatori | File JSONL o tabella DB: è la base per misurare il PoC |

Nessun componente esce dal nostro host: i ticket non vengono inviati a servizi esterni.

### Flusso di un ticket

1. Il software di ticketing notifica il nuovo ticket (webhook) oppure `ticket-triage` lo interroga ogni N minuti (polling).
2. `ticket-triage` costruisce lo **stato** da valutare: oggetto e primo messaggio del ticket, più eventuali metadati utili (reparto del richiedente, canale).
3. Una **sola richiesta** al modello pone entrambe le domande:
   - **Categoria**: scelta tra le categorie in uso, ognuna con una breve descrizione.
   - **Priorità**: posizione su una scala ordinata (es. Bassa → Critica).
4. Si applicano soglie e regole:
   - confidenza della categoria ≥ soglia (es. 0,80) → la categoria viene applicata;
   - sotto soglia → il ticket va nella coda *Da smistare* con il suggerimento del modello;
   - regole di business che hanno sempre la precedenza (es. *Sicurezza* ⇒ priorità almeno *Alta*).
5. Il ticket viene aggiornato con una **nota interna** ("Categoria: rete (95%) · Priorità: Alta · smistato automaticamente") così l'operatore vede perché.
6. Ogni decisione e ogni successiva correzione dell'operatore finiscono nel log.

### Perché un servizio dedicato e non un chatbot con MCP

`jev-mcp` espone lo stesso modello come strumento per assistenti AI (Aether, Claude Code). Per lo smistamento **automatico di ogni ticket** è meglio un servizio dedicato senza LLM nel mezzo: è deterministico, costa zero token di un modello grande, è verificabile e non dipende da come un chatbot decide di chiamare lo strumento.

`jev-mcp` resta utile **accanto** al servizio, per chi gestisce l'helpdesk:

- in Fase 0, per provare diverse tassonomie in linguaggio naturale senza scrivere codice ("classifica questi 100 ticket con queste 7 categorie");
- per analisi ad hoc ("quanti dei ticket aperti questa settimana sono di priorità Alta?").

## 3. Utilizzo

### Che cosa vede l'operatore

| Caso | Che cosa succede nel software di ticketing |
| --- | --- |
| Il modello è sicuro | Categoria e priorità già compilate, con la nota del modello. L'operatore lavora il ticket e, se serve, corregge |
| Il modello è incerto | Il ticket è nella coda *Da smistare* con il suggerimento. L'operatore decide |
| L'operatore corregge | La correzione viene registrata: misura la qualità e serve a rivedere le descrizioni delle categorie |

### Configurazione (in mano all'helpdesk, non agli sviluppatori)

Il comportamento si regola tutto da configurazione, senza riaddestrare il modello:

```yaml
categorie:                       # [DA COMPLETARE: categorie reali in uso]
  accesso:   "Problemi di accesso di un utente esistente: password dimenticata, account bloccato, MFA, permessi mancanti"
  sicurezza: "Phishing, credenziali compromesse, virus, sospetto attacco informatico"
  hardware:  "PC, stampanti, monitor, periferiche guaste o da sostituire"
  software:  "Errori o malfunzionamenti di applicativi e gestionali"
  rete:      "Connettività, VPN, Wi-Fi, posta elettronica non raggiungibile"
  richiesta: "Nuove richieste di servizio: installazioni software, creazione account per nuovi assunti, forniture"
  altro:     "Nessuna delle precedenti"

priorita:                        # dalla più bassa alla più alta
  - "Bassa: nessun impatto, può attendere giorni"
  - "Media: disagio per un singolo utente, ha un workaround"
  - "Alta: un utente o un reparto bloccato nel lavoro"
  - "Critica: servizio aziendale fermo per molti utenti o rischio di sicurezza"

soglia_categoria: 0.80
regole:
  - se: categoria == sicurezza
    allora: priorita >= Alta
```

**Le descrizioni contano quanto il modello.** Nel test preliminare, aggiungere la categoria *sicurezza* e precisare la differenza tra *accesso* (utente esistente) e *richiesta* (nuovo account) ha portato la categoria corretta da **10/12 a 12/12**, senza toccare altro.

### Fasi del PoC

| Fase | Durata | Attività | Impatto sugli operatori |
| --- | --- | --- | --- |
| **0. Tassonomia e dati** | 1 settimana | Estrarre dal software di ticketing 300–500 ticket storici già categorizzati; definire categorie, livelli di priorità e descrizioni | Nessuno |
| **1. Valutazione offline** | 1 settimana | Far classificare lo storico al modello e confrontarlo con le scelte degli operatori; scegliere le soglie | Nessuno |
| **2. Shadow mode** | 2 settimane | Il servizio classifica i ticket reali ma **scrive solo nel log**; si misura la concordanza in tempo reale | Nessuno |
| **3. Modalità assistita** | 2 settimane | Categoria e priorità vengono compilate sopra soglia; sotto soglia va in coda *Da smistare* | Correggono quando serve |

### Criteri di successo (proposta da concordare)

| Metrica | Obiettivo |
| --- | --- |
| Concordanza della **categoria** con l'operatore, sui ticket sopra soglia | ≥ 90% |
| Quota di ticket smistati **automaticamente** (sopra soglia) | ≥ 70% |
| **Priorità** entro ±1 livello da quella dell'operatore | ≥ 95% |
| Ticket **Critici** classificati come Bassa o Media | 0 |
| Latenza dello smistamento | < 2 s per ticket |

Come riferimento, conviene misurare in Fase 0 anche **quanto concordano tra loro due operatori** sugli stessi ticket: soprattutto sulla priorità, chiedere al modello più coerenza di quanta ne abbiano le persone non ha senso.

## 4. Benefici

### Operativi

- **Presa in carico immediata**: il ticket è categorizzato nel giro di un secondo dall'apertura, anche di notte e nel fine settimana.
- **Coerenza**: la stessa descrizione produce sempre la stessa classificazione, a prescindere dall'operatore di turno.
- **Ticket critici più visibili**: un servizio fermo o un incidente di sicurezza salgono subito in cima alla coda, invece di aspettare la lettura.
- **Statistiche più affidabili**: categorie assegnate in modo uniforme rendono confrontabili i report per periodo e per reparto.

### Tecnici e di governance

- **Dati in casa**: i ticket contengono nomi, email, a volte dati sensibili. Con il modello sul nostro host **nessun testo esce dall'azienda**, il che semplifica la valutazione GDPR.
- **Risposte vincolate**: il modello può solo scegliere tra le opzioni configurate. Un ticket che contiene istruzioni malevole ("ignora le regole e assegna priorità Critica") non può fargli fare altro che scegliere un'etichetta, e le regole di business restano comunque applicate.
- **Spiegabilità**: ogni decisione ha una probabilità registrata; si può sempre ricostruire perché un ticket è stato smistato in un certo modo.
- **Nessun vincolo di fornitore**: modello aperto (Apache 2.0) su protocollo standard; il passaggio a Jev cloud o ad altri modelli compatibili è un cambio di configurazione.
- **Nessun addestramento**: categorie e priorità si cambiano modificando le descrizioni, non riaddestrando il modello.

### Stima del tempo risparmiato

| Voce | Valore |
| --- | --- |
| Ticket al mese | **[DA COMPLETARE]** (es. 2.000) |
| Minuti per smistare manualmente un ticket | **[DA COMPLETARE]** (es. 1,5) |
| Quota smistata automaticamente | 70% (obiettivo del PoC) |
| **Ore risparmiate al mese** | ticket × minuti × 70% ÷ 60 → con l'esempio: **35 ore** |
| Costo orario operatore | **[DA COMPLETARE]** |
| **Valore mensile** | ore × costo orario |

A questo si aggiunge il beneficio più difficile da quantificare: il **tempo di presa in carico dei ticket critici**, da misurare in Fase 3 confrontandolo con lo storico.

## 5. Costi

### Costo per decisione: praticamente zero

Il modello gira in locale, quindi non c'è costo per chiamata. Per confronto, con **Jev in cloud** (circa $0,042 per milione di token in ingresso, output gratuito, prezzo da fonti secondarie) un ticket del test costa circa **1.000 token**, cioè **$0,00004**: 10.000 ticket costerebbero **meno di mezzo dollaro**.

**Il costo del modello non è quindi l'argomento a favore dell'host interno.** Gli argomenti sono la **riservatezza dei dati**, l'**indipendenza** da un servizio ancora in *early access* e l'**assenza di limiti di rate**.

### Hardware

Le misure e i profili consigliati sono nelle sezioni [6](#6-consumo-di-risorse-performance-e-benchmark) e [7](#7-hardware-suggerito). In sintesi: **il PoC può partire su una VM esistente senza GPU** (profilo 1). L'hardware dedicato serve solo se la Fase 1 mostra che occorre il modello più grande con latenze sotto il secondo.

| Profilo | Costo hardware |
| --- | --- |
| **1. VM esistente, solo CPU** | Zero, se c'è capienza **[DA COMPLETARE: verificare con IT]** |
| **2. Mini-PC con APU (configurazione testata)** | Una tantum **[DA COMPLETARE: preventivo]** |
| **3. Server con GPU dedicata** | Una tantum, solo se l'uso si estende ad altri casi **[DA COMPLETARE: preventivo]** |

### Effort (stima)

| Attività | Giorni-persona |
| --- | --- |
| Installazione Ollama + modello, hardening dell'host | 0,5 |
| Servizio `ticket-triage` (connettore al software di ticketing, soglie, regole, log) | 3–5 *(dipende dalle API disponibili)* |
| Fase 0: estrazione storico e definizione tassonomia (con l'helpdesk) | 2 |
| Fase 1: valutazione offline e report | 1–2 |
| Monitoraggio Fasi 2–3 e report finale | 2 |
| **Totale** | **~9–12** |

### Costi ricorrenti

- **Energia**: trascurabile. Con nimble su GPU integrata servono **circa 13 Wh ogni 1.000 ticket** (sezione 6): 2.000 ticket al mese sono circa 27 Wh. Il consumo vero è quello della macchina accesa in idle, che su un server già esistente è un costo che c'è comunque.
- **Manutenzione**: aggiornamenti di Ollama e del modello. **Ollama e il modello vanno fissati a una versione precisa** (digest). Nei test il passaggio da Ollama 0.40.3 a 0.40.4 ha richiesto di riscaricare nimble, che ha cambiato digest, e ha ridotto la latenza del 30%. Ogni aggiornamento è quindi un cambiamento da rivalidare.
- **Revisione della tassonomia**: un'ora al mese con l'helpdesk, guardando le correzioni registrate nel log.

## 6. Consumo di risorse, performance e benchmark

Misure effettuate il 17/11/2026 su un mini-PC **AMD Ryzen AI Max+ 395** (16 core Zen 5, GPU integrata Radeon 8060S, 128 GB di RAM unificata, Linux, ROCm), con **Ollama 0.40.4**. Per ogni modello sono stati provati due modi: **GPU integrata** e **solo CPU** (GPU disattivata). Ogni ticket pone le due domande del PoC (categoria + priorità) in una sola richiesta. Metodo e limiti sono nell'[Appendice C](#appendice-c-metodo-di-misura).

### Modelli confrontati

| Modello | Parametri | Download | Licenza |
| --- | --- | --- | --- |
| **nimble** (Bespoke Labs, da Qwen3.5-9B) | 9B | 9,5 GB | Apache 2.0 |
| **tev1** (Together AI) | 4,3B | 4,6 GB | **[DA VERIFICARE]**: non ne ho trovata una dichiarata |
| **tev1:0.8b** | 0,8B | 0,8 GB | **[DA VERIFICARE]** |

### Risultati

| Modello | Dispositivo | Memoria occupata | Avvio a freddo | Latenza per ticket (mediana / p95) | Capacità | Energia per 1.000 ticket | Categoria corretta | Priorità entro ±1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **nimble** | GPU integrata | 9,7 GB | 4,5 s | **0,56 s** / 0,60 s | ~6.300 ticket/h | 13 Wh | 12/12 | 12/12 |
| **nimble** | solo CPU | 10,8 GB RAM | 7,8 s | **4,5 s** / 4,7 s | ~780 ticket/h | 109 Wh | 12/12 | 12/12 |
| **tev1** | GPU integrata | 5,7 GB | 3,0 s | **0,29 s** / 0,30 s | ~12.000 ticket/h | 7 Wh | 12/12 | 12/12 |
| **tev1** | solo CPU | 5,7 GB RAM | 4,3 s | **2,2 s** / 2,2 s | ~1.600 ticket/h | 53 Wh | 12/12 | 12/12 |
| tev1:0.8b | GPU integrata | 1,3 GB | 1,8 s | 0,07 s / 0,08 s | ~43.000 ticket/h | 2 Wh | **9/12** | 10/12 |
| tev1:0.8b | solo CPU | 1,3 GB RAM | 1,5 s | 0,44 s / 0,51 s | ~7.500 ticket/h | 11 Wh | **9/12** | 10/12 |

**Come leggerla:**

- **Qualità**: su questi 12 ticket nimble e tev1 si equivalgono. tev1 ha persino valutato *Critica* il phishing, mentre nimble si era fermato ad *Alta*. tev1:0.8b invece sbaglia 3 categorie su 12 (mouse e monitor finiscono in *software*, "nessuno riceve email" in *altro*) e va **escluso**. Dodici ticket non bastano a scegliere tra nimble e tev1: lo deciderà la Fase 1 sullo storico.
- **Velocità**: la GPU accelera di circa 8 volte. Anche solo su CPU, però, tev1 smista un ticket in 2,2 secondi, che per uno smistamento **asincrono** (nessuno aspetta la risposta davanti allo schermo) è più che sufficiente.
- **Capacità**: anche la configurazione più lenta (nimble su CPU, ~780 ticket/ora) supera di gran lunga il volume di un helpdesk interno **[DA COMPLETARE: picco orario di ticket]**.

### Lunghezza del ticket

La latenza cresce in modo circa lineare con la lunghezza del testo. Misure su GPU integrata, con un ticket a cui vengono incollate righe di log:

| Contenuto | nimble | tev1 | tev1:0.8b |
| --- | --- | --- | --- |
| Ticket breve (~550–1.070 token incluse le domande) | 0,60 s | 0,30 s | 0,08 s |
| + 20 righe di log (~2.600–3.150 token) | 1,5 s | 0,9 s | 0,2 s |
| + 80 righe di log (~8.900–9.400 token) | 4,4 s | 2,6 s | 0,6 s |
| + 200 righe di log (~10.700 token) | **errore** | **errore** | **errore** |

Oltre la finestra di contesto (circa 8.200 token) Ollama **rifiuta la richiesta con un errore esplicito** invece di troncare. Il servizio `ticket-triage` deve quindi tagliare il testo prima di inviarlo: oggetto e primo messaggio, entro un limite fisso di caratteri.

### Una domanda o due

| Modello (GPU integrata) | Solo categoria | Categoria + priorità |
| --- | --- | --- |
| nimble | 0,35 s | 0,56 s |
| tev1 | 0,19 s | 0,29 s |

La seconda domanda aggiunge circa il 60%. Due domande in una richiesta costano meno di due richieste separate.

### Richieste in parallelo

Le richieste contemporanee **non aumentano la capacità**: con 1, 2, 4 o 8 richieste simultanee il numero di ticket all'ora resta lo stesso e cresce solo l'attesa di ciascuna. Il motivo è che il modello valuta già in parallelo le opzioni di una singola domanda (16 sequenze per richiesta) e satura il processore. Per lo stesso motivo **`OLLAMA_NUM_PARALLEL` non ha effetto**: provato a 1 e a 4, risultati identici. La capacità si aumenta solo con hardware più veloce o con un modello più piccolo.

### Consumi elettrici

| Stato | Potenza del package (CPU + GPU) |
| --- | --- |
| Idle, modello non caricato | 10–18 W |
| Durante lo smistamento, qualsiasi modello e dispositivo | ~85 W (limite di potenza configurato per l'APU) |

Il consumo per ticket dipende solo dal tempo di calcolo: 85 W × 0,56 s fa circa 13 Wh ogni 1.000 ticket per nimble su GPU. Sono valori del **sensore del processore**, non misure alla presa: il consumo dell'intero sistema (RAM, disco, alimentatore) è più alto e non è stato misurato.

### Memoria

| Modello | GPU integrata | Solo CPU |
| --- | --- | --- |
| nimble | 9,7 GB di memoria GPU + 1,6 GB di RAM per il processo | 10,8 GB di RAM |
| tev1 | 5,7 GB di memoria GPU + 1,2 GB di RAM | 5,7 GB di RAM |

A questo vanno aggiunti sistema operativo e servizio `ticket-triage`, che è leggero (un processo Node.js).

### Avvio a freddo

Il primo ticket dopo il caricamento del modello richiede **3–8 secondi**. Con le impostazioni predefinite Ollama scarica il modello dopo **5 minuti di inattività**, e il ticket successivo paga di nuovo l'avvio. Va impostato `OLLAMA_KEEP_ALIVE=-1` per tenere il modello sempre in memoria.

### Benchmark esterni di riferimento

Su GPU da datacenter (NVIDIA H100) un blog indipendente riporta per nimble circa **69 ms per una domanda** e **392 ms per tre domande**, e valori simili per tev1. Sono valori di terzi, non verificati, ma danno l'ordine di grandezza del profilo 3.

## 7. Hardware suggerito

**Lo smistamento è asincrono.** Tra l'apertura di un ticket e la lettura da parte di un operatore passano minuti: che il modello risponda in 0,3 o in 4 secondi non cambia nulla per l'utente. Per questo il fattore che decide l'hardware è la **qualità** del modello scelto in Fase 1, non la velocità.

| Profilo | Hardware | Modello | Prestazioni attese | Quando sceglierlo |
| --- | --- | --- | --- | --- |
| **1. VM esistente, solo CPU** (consigliato per il PoC) | x86-64 recente con AVX2/AVX-512, **8–16 vCPU**, **16 GB RAM** con tev1 oppure **24 GB** con nimble, 30 GB di disco | tev1 (o nimble) | tev1: ~2–5 s per ticket; nimble: ~5–10 s *(stima: le misure sono su 16 core fisici, una VM con meno core sarà proporzionalmente più lenta)* | Per partire subito, senza acquisti |
| **2. Mini-PC con APU** (configurazione testata) | AMD Ryzen AI Max+ 395 (Radeon 8060S), **≥ 64 GB RAM unificata**, SSD ≥ 500 GB | nimble | 0,56 s per ticket, ~6.300 ticket/h, ~85 W sotto carico | Se la Fase 1 premia nimble e serve un host dedicato, compatto e a basso consumo, con spazio per altri modelli |
| **3. Server con GPU dedicata** | GPU con **≥ 16 GB di VRAM** (24 GB per avere margine), 32 GB RAM | nimble ed eventuali altri modelli | Non misurato qui; su H100 ~70 ms per domanda (fonte esterna) | Se l'uso si estende ad altri casi (email, documenti, moderazione) o ad alti volumi |

### Configurazione di Ollama consigliata

```bash
OLLAMA_HOST=127.0.0.1:11434   # solo locale: ticket-triage gira sulla stessa macchina
OLLAMA_KEEP_ALIVE=-1          # modello sempre caricato, niente avvio a freddo
OLLAMA_IGPU_ENABLE=1          # solo per GPU integrate (profilo 2), da Ollama 0.40.4
```

Accorgimenti emersi durante i test:

- **GPU integrate**: dalla 0.40.4 Ollama le ignora se non si imposta `OLLAMA_IGPU_ENABLE=1`, e passa in silenzio alla CPU (8 volte più lenta). Non va impostato `HSA_OVERRIDE_GFX_VERSION`: forza un'architettura sbagliata (`gfx1100` invece di `gfx1151`).
- **Rete**: Ollama non ha autenticazione. Se `ticket-triage` è su un'altra macchina, la porta va protetta da firewall e non esposta su `0.0.0.0`.
- **`OLLAMA_NUM_PARALLEL`**: per i modelli decisionali è inutile (vedi sopra).
- **Versioni fissate**: annotare versione di Ollama e digest del modello; ogni aggiornamento si fa ripetendo la valutazione della Fase 1.

## 8. Rischi e mitigazioni

| Rischio | Mitigazione |
| --- | --- |
| **La priorità tende al centro della scala.** Nel test, priorità esatta solo in 6/12 casi (sempre entro ±1); un gestionale fermo per un intero reparto è stato valutato *Alta* invece di *Critica* | Il punteggio è continuo (es. 2,04 su 0–3): le soglie per livello si tarano in Fase 1 sullo storico; regole di business per i casi noti (molti utenti coinvolti, sicurezza) |
| Ticket ambigui o fuori tassonomia | La soglia di confidenza li manda in coda *Da smistare*. Nel test, "nessuno riceve email" ha avuto confidenza 0,40 e sarebbe andato all'operatore |
| Ticket molto lunghi (thread, log incollati) | Oltre ~8.200 token Ollama restituisce un errore e non tronca: il servizio valuta solo oggetto e primo messaggio, tagliati a un limite fisso |
| Gli operatori non si fidano del sistema | Shadow mode prima di attivarlo; nota con la confidenza su ogni ticket; correzione sempre possibile |
| Aggiornamenti di Ollama o del modello che cambiano il comportamento (nei test: 0.40.3 → 0.40.4 ha cambiato digest e latenza di nimble) | Versioni fissate; ogni aggiornamento si fa ripetendo la valutazione offline della Fase 1 |
| GPU integrata ignorata dopo un aggiornamento di Ollama, con passaggio silenzioso alla CPU | `OLLAMA_IGPU_ENABLE=1`; monitorare la latenza del servizio, che passerebbe da ~0,5 s a ~4,5 s |
| Licenza di tev1 non chiara | Verificarla prima della Fase 1; in alternativa nimble (Apache 2.0) |

## 9. Prossimi passi

1. Confermare con chi gestisce il software di ticketing le API disponibili (lettura ticket, scrittura campi, webhook).
2. Estrarre 300–500 ticket storici già classificati (anonimizzati se necessario).
3. Definire con l'helpdesk categorie, livelli di priorità e regole.
4. Verificare con IT una VM per il profilo 1 (8–16 vCPU, 24 GB RAM) e la licenza di tev1.
5. Avviare la Fase 0. In Fase 1 confrontare nimble e tev1 sullo storico, misurando anche la latenza sulla VM reale.

---

## Appendice A: richiesta al modello

Una sola chiamata HTTP per ticket, con entrambe le domande:

```http
POST http://<host>:11434/v1/systemone
Content-Type: application/json
```

```json
{
  "model": "nimble",
  "state": "Oggetto: VPN non funziona\nVPN non si connette da casa, oggi sono in smart working e non posso lavorare",
  "questions": {
    "categoria": {
      "type": "choice",
      "instructions": "A quale categoria appartiene questo ticket di assistenza interna?",
      "criteria": {
        "accesso": "Problemi di accesso di un utente esistente: password dimenticata, account bloccato, MFA, permessi mancanti",
        "rete": "Connettività, VPN, Wi-Fi, posta elettronica non raggiungibile",
        "...": "..."
      }
    },
    "priorita": {
      "type": "score",
      "instructions": "Quanto è urgente questo ticket per l'operatività aziendale?",
      "criteria": ["Bassa: …", "Media: …", "Alta: …", "Critica: …"]
    }
  }
}
```

Risposta (ridotta):

```json
{
  "answers": {
    "categoria": { "type": "choice", "choice": "rete", "confidence": 0.96, "probabilities": { "rete": 0.96, "...": 0.04 } },
    "priorita":  { "type": "score", "score": 2.00, "confidence": 0.81, "probabilities": { "...": 0 } }
  }
}
```

`score` è la media dei livelli (0 = Bassa … 3 = Critica) pesata per la probabilità: 2,00 significa *Alta*. Un valore come 2,45 indica un caso a metà tra *Alta* e *Critica*, ed è qui che si applicano le soglie tarate in Fase 1.

## Appendice B: risultati del test preliminare

Test eseguito il 19/10/2026 su 12 ticket **di esempio** scritti a mano (non ticket reali), con Ollama 0.40.3 e `nimble` (Q8_0) su AMD Ryzen AI Max (Radeon 8060S), con la tassonomia della sezione 3.

| Ticket | Categoria (conf.) | Attesa | Priorità (score → livello) | Attesa |
| --- | --- | --- | --- | --- |
| Password di Windows dimenticata | accesso (0,95) | accesso | 1,73 → Alta | Alta |
| Stampante fa righe | hardware (0,84) | hardware | 1,35 → Media | Media |
| Gestionale ordini in errore per tutto il reparto | software (0,96) | software | 2,04 → Alta | **Critica** |
| VPN non va, in smart working | rete (0,96) | rete | 2,00 → Alta | Alta |
| Installare Visio | richiesta (0,97) | richiesta | 0,69 → Media | **Bassa** |
| Mouse si blocca a volte | hardware (0,85) | hardware | 1,12 → Media | **Bassa** |
| Click su link di phishing con credenziali | sicurezza (0,91) | sicurezza | 2,41 → Alta | **Critica** |
| Nessuno in sede riceve email | rete (**0,40**) | rete | 2,56 → Critica | Critica |
| Excel si chiude sul file budget | software (0,90) | software | 2,00 → Alta | **Media** |
| Account per nuovo collega | richiesta (0,99) | richiesta | 1,35 → Media | Media |
| Monitor secondario non rilevato | hardware (0,77) | hardware | 1,38 → Media | Media |
| Wi-Fi lento in sala riunioni | rete (0,95) | rete | 1,94 → Alta | **Media** |

| Sintesi | Prima tassonomia | Tassonomia rivista |
| --- | --- | --- |
| Categoria corretta | 10/12 | **12/12** |
| Priorità esatta | 7/12 | 6/12 |
| Priorità entro ±1 | 12/12 | 12/12 |
| Latenza mediana | 0,74 s | 0,80 s |

**Come leggerli:** 12 ticket scritti a mano dimostrano che la catena funziona e danno un ordine di grandezza delle latenze. Non misurano l'accuratezza sui ticket reali, che è proprio l'obiettivo della Fase 1. Con la regola *Sicurezza ⇒ almeno Alta* e soglie tarate, il caso del phishing sarebbe già gestito; il caso del gestionale fermo è quello da cui partire per tarare la priorità.

## Appendice C: metodo di misura

- **Macchina**: AMD Ryzen AI Max+ 395 (16 core / 32 thread, Radeon 8060S `gfx1151`), 128 GB di RAM unificata, Linux 7.0, ROCm 7.2 incluso in Ollama.
- **Software**: Ollama 0.40.4 in tre configurazioni (GPU integrata, GPU integrata con `OLLAMA_NUM_PARALLEL=4`, solo CPU) e il servizio di sistema 0.40.3 per il confronto tra versioni. `LLAMA_ARG_MMAP=0`, tutti gli strati del modello sulla GPU.
- **Carico**: i 12 ticket dell'Appendice B con la tassonomia rivista, due domande per richiesta. Le latenze sono misurate lato client e la capacità è calcolata sulle latenze di ticket **non ripetuti**.
- **Correzione rispetto alla prima versione**: Ollama 0.40.3 mette in cache le richieste identiche, quindi il test in parallelo della prima versione, fatto con ticket ripetuti, sovrastimava la capacità. La stima di "~10.000 ticket/ora" della prima versione è stata sostituita dai valori della sezione 6. Su ticket nuovi, nimble impiega 0,80 s con la 0.40.3 e 0,56 s con la 0.40.4.
- **Concorrenza**: 48 richieste con 1, 2, 4 e 8 client simultanei.
- **Energia**: potenza del package letta da `rocm-smi` ogni 0,5 s durante il carico. Non sono misure alla presa.
- **Limiti**: 12 ticket scritti a mano e una sola macchina. Le prestazioni su VM e GPU dedicate (profili 1 e 3) sono stime da verificare in Fase 1.

## Fonti

- Protocollo e modelli decisionali in Ollama: [Run Jev-style decision models locally with Ollama](https://llmconfigurator.com/en/guides/decision-models/ollama-setup), [Ollama adds local decision models](https://runtimewire.com/article/ollama-local-decision-models-systemone), [nimble su Ollama](https://ollama.com/library/nimble:9b)
- Valutazione di nimble e benchmark su H100 (fonti di terzi): [Evaluating a decision model: Nimble 9B](https://blog.devgenius.io/evaluating-a-decision-model-nimble-9b-and-its-base-model-qwen3-5-9b-a845c2bbd7f0), [Decision models: run Jev-style System One models on your own hardware](https://llmconfigurator.com/en/guides/decision-models)
- Release di Ollama usata per i benchmark: [ollama/ollama v0.40.4](https://github.com/ollama/ollama/releases/tag/v0.40.4)
- Prezzi di Jev (fonti secondarie, TypeSafe non pubblica un listino): [eesel.ai](https://www.eesel.ai/blog/typesafe-jev-pricing), [Latenode](https://latenode.com/news/typesafe-launches-jev-as-a-low-cost-decision-api-amid-access-questions)
- Alternativa compatibile: [Contrastive-LM/CLM](https://github.com/Contrastive-LM/CLM)
