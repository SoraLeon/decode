const romInput = document.getElementById("romInput");
const patchInput = document.getElementById("patchInput");
const outputFileName = document.getElementById("outputFileName");
const applyPatchButton = document.getElementById("applyPatchButton");
const clearPatcherButton = document.getElementById("clearPatcherButton");
const patcherStatus = document.getElementById("patcherStatus");
const downloadPatchButton = document.querySelector("#download .download-button");

let patchWorker = null;
let romPatcherDepsPromise = null;

const ROM_PATCHER_SCRIPT_PATHS = [
    "./rom-patcher-js/modules/BinFile.js",
    "./rom-patcher-js/modules/HashCalculator.js",
    "./rom-patcher-js/modules/RomPatcher.format.ips.js",
    "./rom-patcher-js/modules/RomPatcher.format.ups.js",
    "./rom-patcher-js/modules/RomPatcher.format.aps_n64.js",
    "./rom-patcher-js/modules/RomPatcher.format.aps_gba.js",
    "./rom-patcher-js/modules/RomPatcher.format.bps.js",
    "./rom-patcher-js/modules/RomPatcher.format.rup.js",
    "./rom-patcher-js/modules/RomPatcher.format.ppf.js",
    "./rom-patcher-js/modules/RomPatcher.format.bdf.js",
    "./rom-patcher-js/modules/RomPatcher.format.pmsr.js",
    "./rom-patcher-js/modules/RomPatcher.format.vcdiff.js",
    "./rom-patcher-js/modules/zip.js/zip.min.js",
    "./rom-patcher-js/RomPatcher.js"
];

function setPatcherStatus(message, type = "") {
    patcherStatus.className = `status-box${type ? ` ${type}` : ""}`;
    patcherStatus.textContent = message;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** exponent);
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function getBaseName(filename) {
    return filename.replace(/\.[^/.]+$/, "");
}

function getExtension(filename) {
    const match = filename.match(/(\.[^./\\]+)$/);
    return match ? match[1] : ".bin";
}

function suggestOutputName() {
    const romFile = romInput.files?.[0];
    if (!romFile) return;
    outputFileName.value = `${getBaseName(romFile.name)} [PT-BR]${getExtension(romFile.name)}`;
}

function hasConfiguredPatchUrl() {
    if (!downloadPatchButton) return false;
    const href = downloadPatchButton.getAttribute("href");
    return Boolean(href && href.trim() && href.trim() !== "#");
}

async function getPatchData() {
    const selectedPatch = patchInput.files?.[0];
    if (selectedPatch) {
        return {
            bytes: new Uint8Array(await selectedPatch.arrayBuffer()),
            name: selectedPatch.name,
            source: "arquivo selecionado"
        };
    }

    if (!hasConfiguredPatchUrl()) {
        throw new Error("Nenhum patch foi selecionado e o botão de download ainda não possui um link real configurado.");
    }

    setPatcherStatus("Baixando o patch configurado no site...", "loading");

    let response;
    try {
        response = await fetch(downloadPatchButton.href);
    } catch (error) {
        throw new Error("Falha ao baixar o patch pelo link configurado. Se o patch estiver em outro domínio, verifique CORS ou selecione o arquivo .vcdiff manualmente.");
    }

    if (!response.ok) {
        throw new Error(`Não foi possível baixar o patch do site (${response.status}).`);
    }

    const patchNameFromUrl = downloadPatchButton.href.split("/").pop()?.split("?")[0] || "patch.vcdiff";
    return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        name: patchNameFromUrl,
        source: "link configurado no botão de download"
    };
}

function loadScriptSequentially(src) {
    return new Promise((resolve, reject) => {
        const existingScript = document.querySelector(`script[data-rom-patcher-src="${src}"]`);
        if (existingScript) {
            if (existingScript.dataset.loaded === "true") {
                resolve();
            } else {
                existingScript.addEventListener("load", () => resolve(), { once: true });
                existingScript.addEventListener("error", () => reject(new Error(`Falha ao carregar ${src}`)), { once: true });
            }
            return;
        }

        const script = document.createElement("script");
        script.src = src;
        script.async = false;
        script.dataset.romPatcherSrc = src;
        script.addEventListener("load", () => {
            script.dataset.loaded = "true";
            resolve();
        }, { once: true });
        script.addEventListener("error", () => reject(new Error(`Falha ao carregar ${src}`)), { once: true });
        document.head.appendChild(script);
    });
}

async function loadRomPatcherDependencies() {
    if (window.BinFile && window.RomPatcher) return;
    if (!romPatcherDepsPromise) {
        romPatcherDepsPromise = (async () => {
            for (const scriptPath of ROM_PATCHER_SCRIPT_PATHS) {
                await loadScriptSequentially(scriptPath);
            }
        })();
    }
    return romPatcherDepsPromise;
}

function ensurePatchWorker() {
    if (patchWorker) return patchWorker;
    patchWorker = new Worker("./rom-patcher-js/RomPatcher.webworker.apply.js");
    return patchWorker;
}

function applyPatchWithWorker(romBytes, romName, patchBytes, patchName) {
    return new Promise((resolve, reject) => {
        const worker = ensurePatchWorker();

        const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
        };

        const onMessage = (event) => {
            cleanup();
            const data = event.data || {};
            if (data.patchedRomU8Array) {
                resolve({
                    output: new Uint8Array(data.patchedRomU8Array),
                    suggestedName: data.patchedRomFileName || romName
                });
            } else {
                reject(new Error(data.errorMessage || "Falha desconhecida ao aplicar o patch."));
            }
        };

        const onError = () => {
            cleanup();
            reject(new Error("O navegador não conseguiu iniciar o worker do aplicador. Confirme se a pasta rom-patcher-js está ao lado do HTML e se o arquivo está sendo servido corretamente."));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage(
            {
                romFileU8Array: romBytes,
                romFileName: romName,
                patchFileU8Array: patchBytes,
                patchFileName: patchName,
                options: {
                    requireValidation: false,
                    removeHeader: false,
                    addHeader: false,
                    fixChecksum: false,
                    outputSuffix: false
                }
            },
            [romBytes.buffer, patchBytes.buffer]
        );
    });
}

async function applyPatchInMainThread(romBytes, romName, patchBytes, patchName) {
    await loadRomPatcherDependencies();

    const romFile = new BinFile(romBytes);
    romFile.fileName = romName;

    const patchFile = new BinFile(patchBytes);
    patchFile.fileName = patchName;

    const parsedPatch = RomPatcher.parsePatchFile(patchFile);
    if (!parsedPatch) {
        throw new Error("O arquivo de patch não foi reconhecido. Use um patch válido em formato .vcdiff/.xdelta compatível.");
    }

    const patchedRom = RomPatcher.applyPatch(romFile, parsedPatch, {
        requireValidation: false,
        removeHeader: false,
        addHeader: false,
        fixChecksum: false,
        outputSuffix: false
    });

    return {
        output: new Uint8Array(patchedRom._u8array.buffer.slice(0)),
        suggestedName: patchedRom.fileName || romName
    };
}

async function applyPatch(romBytes, romName, patchBytes, patchName) {
    const shouldUseMainThread = location.protocol === "file:";

    if (shouldUseMainThread) {
        setPatcherStatus("Arquivo aberto localmente detectado. Aplicando o patch sem worker para evitar o bloqueio do navegador...", "loading");
        return applyPatchInMainThread(romBytes, romName, patchBytes, patchName);
    }

    try {
        return await applyPatchWithWorker(romBytes, romName, patchBytes, patchName);
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        const workerBlocked = /worker|origin 'null'|cannot be accessed/i.test(message);
        if (!workerBlocked) {
            throw error;
        }

        setPatcherStatus("Worker bloqueado pelo navegador. Tentando aplicar o patch no mesmo processo da página...", "loading");
        return applyPatchInMainThread(romBytes, romName, patchBytes, patchName);
    }
}

function triggerDownload(fileName, bytes) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetPatcherFields() {
    romInput.value = "";
    patchInput.value = "";
    outputFileName.value = "";
    setPatcherStatus("Selecione a ROM base e o patch .vcdiff/.xdelta para começar.");
}

romInput?.addEventListener("change", suggestOutputName);
clearPatcherButton?.addEventListener("click", resetPatcherFields);

applyPatchButton?.addEventListener("click", async () => {
    const romFile = romInput.files?.[0];

    if (!romFile) {
        setPatcherStatus("Selecione primeiro a ROM base do jogo.", "error");
        return;
    }

    applyPatchButton.disabled = true;

    try {
        setPatcherStatus("Carregando ROM e aplicador baseado em rom-patcher-js...", "loading");

        const [patchData, romBytesBuffer] = await Promise.all([
            getPatchData(),
            romFile.arrayBuffer()
        ]);

        const romBytes = new Uint8Array(romBytesBuffer);
        const patchBytes = patchData.bytes;

        setPatcherStatus(
            `Aplicando patch...\nROM: ${formatBytes(romBytes.byteLength)}\nPatch: ${formatBytes(patchBytes.byteLength)} (${patchData.source})\nMotor: RomPatcher.js / VCDIFF`,
            "loading"
        );

        const result = await applyPatch(romBytes, romFile.name, patchBytes, patchData.name);
        const finalName = (outputFileName.value || `${getBaseName(romFile.name)} [PT-BR]${getExtension(romFile.name)}`).trim();

        triggerDownload(finalName, result.output);

        setPatcherStatus(
            `ROM traduzida gerada com sucesso!\nArquivo final: ${finalName}\nTamanho de saída: ${formatBytes(result.output.byteLength)}\nO download foi iniciado automaticamente.`,
            "success"
        );
    } catch (error) {
        console.error(error);
        setPatcherStatus(
            `${error.message}\n\nSe o problema persistir, confira se a ROM base está limpa, se o patch é realmente .vcdiff/.xdelta e se a pasta rom-patcher-js acompanha este HTML.`,
            "error"
        );
    } finally {
        applyPatchButton.disabled = false;
    }
});
