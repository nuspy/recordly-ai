# Recordly AI — pacchetto di installazione con InstallForge

> **Progetto pronto**: `installer\RecordlyAI.ifp` implementa queste istruzioni. Prima di aprirlo in
> InstallForge esegui `installer\stage.ps1` (dopo ogni build). Differenza di layout: InstallForge installa
> una cartella come sottocartella, quindi i file stanno in `<InstallPath>\app\` (es.
> `C:\Program Files\Recordly AI\app\RecordlyAI.exe`); la skill è in `app\skills\`, il runtime VC++ in
> `app\prereq\` e viene eseguito in silenzio a fine copia. La sezione 3.2 (GPU) non è un componente
> separato: InstallForge nel formato `.ifp` non ha componenti opzionali, la cartella CUDA è sempre inclusa.

Questo documento descrive **cosa** deve contenere il setup e **dove** va ogni cosa. Il
pacchetto lo costruisci a mano in InstallForge partendo dalla cartella prodotta dalla build.

---

## 1. Produrre i file da installare

Prerequisiti sulla macchina di build (già presenti su PLUTO-MAX):

| Strumento | Versione | Note |
|---|---|---|
| Node.js | 24.x | `npm ci` una volta |
| Visual Studio 2026 | con il componente **MSVC v143 – 14.44** | serve a CUDA: nvcc 13.1 non accetta MSVC 14.5x |
| CUDA Toolkit | 13.1 (`CUDA_PATH` impostata) | per il runtime Whisper GPU (RTX 50xx / sm_120) |
| CMake + Ninja | recenti | |

Build (PowerShell, dalla radice del progetto):

```powershell
Remove-Item Env:_CL_ -ErrorAction SilentlyContinue   # nel tuo profilo c'è _CL_=/std:c++20: rompe la build C di whisper.cpp
$env:WHISPER_RUNTIME_CUDA = "1"                       # compila whisper-cli con CUDA 13.1 (architetture 89;120)
npm run build:win:installforge
```

Risultato: **`E:\Projects\recordly\release\win-unpacked\`** (≈ 1,2 GB, di cui 568 MB runtime
CUDA). È l'app completa e già funzionante: InstallForge deve solo copiarla.

> La build CUDA viene saltata se `electron\native\bin\win32-x64-cuda\` è già aggiornata
> (versione whisper.cpp v1.8.4). Per forzarla cancella quella cartella.

---

## 2. Impostazioni generali del progetto InstallForge

| Campo | Valore |
|---|---|
| Product name | `Recordly AI` |
| Product version | `1.4.0` (da `package.json`) |
| Company | a tua scelta |
| Install directory | `<ProgramFiles>\Recordly AI` |
| Architettura | 64 bit (l'app è solo x64) |
| Privilegi | amministratore (installazione in Program Files) |
| Lingue setup | Italiano / English |
| Licenza da mostrare | `E:\Projects\recordly\LICENSE.md` (AGPL-3.0) |
| Icona setup | `E:\Projects\recordly\icons\icons\win\icon.ico` |

> Il nome della cartella `Recordly AI` e l'eseguibile `RecordlyAI.exe` sono quelli che lo
> script degli agenti (`recordly_ai.py launch`) cerca per primi. Se scegli un'altra cartella va
> bene lo stesso: l'app scrive il proprio percorso in `%APPDATA%\Recordly AI\automation\app.json`
> al primo avvio.

---

## 3. File da includere (sezione "Files")

### 3.1 Componente **Recordly AI** (obbligatorio)

Copia **tutto il contenuto** di `release\win-unpacked\` in `<InstallPath>\`, ricorsivamente,
mantenendo la struttura:

```
<InstallPath>\                                   ← C:\Program Files\Recordly AI\
├─ RecordlyAI.exe                                 eseguibile principale
├─ *.dll, *.pak, *.bin, *.dat, *.json             runtime Electron/Chromium (tutti i file della radice)
├─ LICENSE.electron.txt, LICENSES.chromium.html
├─ locales\                                       (tutta la cartella)
└─ resources\
   ├─ app.asar                                    codice dell'app
   ├─ assets\wallpapers\                          sfondi
   └─ app.asar.unpacked\
      ├─ node_modules\ffmpeg-static\              ffmpeg.exe
      ├─ node_modules\ffprobe-static\             ffprobe.exe
      ├─ node_modules\uiohook-napi\               hook mouse/tastiera
      ├─ node_modules\capturekit\
      └─ electron\native\bin\
         ├─ win32-x64\                            cattura WGC, export GPU, whisper CPU (obbligatoria)
         ├─ darwin-arm64\, darwin-x64\            inutili su Windows: puoi escluderle (≈ 4 MB)
         └─ win32-x64-cuda\                       → vedi 3.2
```

⚠️ Non spostare né rinominare nulla dentro `resources\`: l'app cerca i binari nativi con
questi percorsi relativi.

### 3.2 Componente **Accelerazione GPU NVIDIA per i sottotitoli** (opzionale, consigliato)

`release\win-unpacked\resources\app.asar.unpacked\electron\native\bin\win32-x64-cuda\` →
`<InstallPath>\resources\app.asar.unpacked\electron\native\bin\win32-x64-cuda\`

| File | Dimensione |
|---|---|
| `whisper-cli.exe` (CUDA 13.1, sm_89 + sm_120) | 93 MB |
| `cublasLt64_13.dll` | 449 MB |
| `cublas64_13.dll` | 52 MB |
| `cudart64_13.dll` | 0,5 MB |
| `whisper-runtime.json` | — |

Se il componente non viene installato (PC senza NVIDIA) l'app usa automaticamente Whisper su
CPU, o il bridge CallAPICall se è attivo. Richiede un driver NVIDIA che supporti CUDA 13
(R580 o successivo; su PLUTO-MAX c'è il 616.92).

### 3.3 Componente **Skill per agenti AI** (opzionale)

`E:\Projects\recordly\skills\recordly-ai-demo\` → `<InstallPath>\skills\recordly-ai-demo\`

```
skills\recordly-ai-demo\
├─ SKILL.md
├─ references\   (6 file .md)
├─ scripts\      (recordly_ai.py, demo_runner.py, tts.py, install.py, requirements.txt)
└─ templates\    (demo-script.example.yaml, pipelines\*.yaml)
```

Escludi eventuali `__pycache__\` e `.narration-cache\`.

### 3.4 Prerequisito **Microsoft Visual C++ Redistributable x64** (obbligatorio)

`whisper-cli.exe` e gli helper nativi usano il runtime MSVC. Includi `vc_redist.x64.exe`
(https://aka.ms/vc14/vc_redist.x64.exe) e, nella sezione "Run program" / prerequisiti,
eseguilo **prima** della copia dei file con:

```
vc_redist.x64.exe /install /quiet /norestart
```

---

## 4. Collegamenti (sezione "Shortcuts")

| Collegamento | Destinazione | Argomenti | Dove |
|---|---|---|---|
| `Recordly AI` | `<InstallPath>\RecordlyAI.exe` | — | Menu Start + Desktop |
| `Recordly AI (server)` *(opzionale)* | `<InstallPath>\RecordlyAI.exe` | `--server` | Menu Start |

Icona: quella dell'eseguibile (indice 0). La modalità server parte senza finestre ed è
controllabile solo via REST (`http://127.0.0.1:47800`).

---

## 5. Registro, protocolli, associazioni

- **Nessuna chiave di registro obbligatoria.**
- Il protocollo `recordly://` (login cloud) lo registra l'app da sola al primo avvio, in
  `HKCU\Software\Classes\recordly`.
- **Associazione dei file `.recordly`: non crearla.** L'app non apre progetti passati da riga di
  comando (non lo fa nemmeno Recordly upstream su Windows): i progetti si aprono dalla libreria.
- Non servono eccezioni del firewall: la REST API ascolta solo su `127.0.0.1`.

---

## 6. Azioni dopo l'installazione (opzionali)

| Azione | Comando | Nota |
|---|---|---|
| Avvia Recordly AI | `<InstallPath>\RecordlyAI.exe` | checkbox "Avvia ora" |
| Installa la skill per gli agenti | `python "<InstallPath>\skills\recordly-ai-demo\scripts\install.py" -g --deps` | richiede Python 3.9+ nel PATH; collega la skill in `~/.claude`, `~/.agents`, `~/.gemini`, Hermes e installa PyYAML + pywinauto |

Se il setup gira elevato con un account amministratore diverso dall'utente, la skill verrebbe
installata nella home di quell'account: in quel caso lascia la checkbox disattivata e fai
lanciare il comando all'utente.

---

## 7. Disinstallazione

1. (Se la skill era stata installata) `python "<InstallPath>\skills\recordly-ai-demo\scripts\install.py" -g --uninstall`
   — rimuove solo i collegamenti, mai i file della skill.
2. Rimuovere `<InstallPath>\` e i collegamenti.
3. **Non** cancellare per default i dati utente: `%APPDATA%\Recordly AI\` (impostazioni,
   preset, token REST, registrazioni e progetti se non hai scelto un'altra cartella). Al
   massimo offri una checkbox "Rimuovi anche i dati utente".
4. Facoltativo: `HKCU\Software\Classes\recordly` (protocollo di login).

---

## 8. Cose da sapere

- **Coesistenza con Recordly originale**: Recordly AI ha nome, eseguibile, cartella dati e appId
  propri (`dev.recordly.ai`), quindi può stare installato insieme a Recordly. Al primo avvio
  importa una sola volta le preferenze da `%APPDATA%\Recordly` (preset, scorciatoie, cartella
  registrazioni, progetti recenti); registrazioni e modelli restano dove sono.
- **Aggiornamenti automatici disattivati** nel fork: ogni versione nuova va reinstallata con il
  setup InstallForge.
- **Firma digitale**: la build non ha un certificato di code signing; Windows SmartScreen
  mostrerà l'avviso "editore sconosciuto" finché non firmi `RecordlyAI.exe` e il setup.
- **Verifica dopo l'installazione**:
  `python "<InstallPath>\skills\recordly-ai-demo\scripts\recordly_ai.py" launch` deve
  rispondere `"ready": true` entro qualche secondo.
