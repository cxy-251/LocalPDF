import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "./App.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Fixed, always-overwritten scratch path so repeated test clicks never pile
// up new files, and the original the user dropped in is never touched.
function scratchPreviewPath(path: string) {
  return path.replace(/\.pdf$/i, ".localpdf-preview.pdf");
}

type ConvertProgress = {
  event: "start" | "done" | "error";
  output?: string;
  message?: string;
};

type ToolId =
  | "convert-word"
  | "office-to-pdf"
  | "compress"
  | "watermark"
  | "page-numbers"
  | "rotate"
  | "crop"
  | "delete"
  | "to-images"
  | "from-images"
  | "encrypt"
  | "decrypt"
  | "settings";

const TOOL_GROUPS: { title: string; items: { id: ToolId; label: string }[] }[] = [
  {
    title: "转换",
    items: [
      { id: "convert-word", label: "转换为 Word" },
      { id: "office-to-pdf", label: "Office 转 PDF" },
    ],
  },
  {
    title: "页面处理",
    items: [
      { id: "compress", label: "压缩" },
      { id: "watermark", label: "加水印" },
      { id: "page-numbers", label: "加页码" },
      { id: "rotate", label: "旋转当前页" },
      { id: "crop", label: "裁剪当前页" },
      { id: "delete", label: "删除当前页" },
    ],
  },
  {
    title: "图片",
    items: [
      { id: "to-images", label: "导出为图片" },
      { id: "from-images", label: "图片合并为 PDF" },
    ],
  },
  {
    title: "安全",
    items: [
      { id: "encrypt", label: "加密" },
      { id: "decrypt", label: "解密" },
    ],
  },
];

const NEEDS_LOADED_PDF: ToolId[] = [
  "convert-word",
  "compress",
  "watermark",
  "page-numbers",
  "rotate",
  "crop",
  "delete",
  "to-images",
  "encrypt",
  "decrypt",
];

function readStoredLibreOfficePath(): string | null {
  try {
    return localStorage.getItem("libreOfficePath");
  } catch {
    return null;
  }
}

function readStoredInvertPreference(): boolean {
  try {
    return localStorage.getItem("invertPdfColors") === "1";
  } catch {
    return false;
  }
}

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [libreOfficePath, setLibreOfficePath] = useState<string | null>(readStoredLibreOfficePath);
  const [useLibreOffice, setUseLibreOffice] = useState(false);
  const [invertColors, setInvertColors] = useState<boolean>(readStoredInvertPreference);
  const [activeTool, setActiveTool] = useState<ToolId>("convert-word");
  const [watermarkText, setWatermarkText] = useState("CONFIDENTIAL");
  const [cropMargin, setCropMargin] = useState(20);
  const [encryptPassword, setEncryptPassword] = useState("");
  const [decryptPassword, setDecryptPassword] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);

  const renderPage = useCallback(async (pageNum: number) => {
    const doc = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.2 });
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport, canvas }).promise;
  }, []);

  const loadPdf = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const bytes = await readFile(path);
        const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        pdfDocRef.current = doc;
        setPageCount(doc.numPages);
        setFilePath(path);
        setCurrentPage(1);
        await renderPage(1);
      } catch (e) {
        setError(String(e));
        setPageCount(null);
        setFilePath(null);
      }
    },
    [renderPage],
  );

  const goToPage = useCallback(
    async (delta: number) => {
      if (!pageCount) return;
      const next = Math.min(Math.max(currentPage + delta, 1), pageCount);
      if (next === currentPage) return;
      setCurrentPage(next);
      await renderPage(next);
    },
    [currentPage, pageCount, renderPage],
  );

  const handleOpenDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected === "string") {
      await loadPdf(selected);
    }
  }, [loadPdf]);

  const toggleInvertColors = useCallback(() => {
    setInvertColors((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("invertPdfColors", next ? "1" : "0");
      } catch {
        // best-effort persistence only
      }
      return next;
    });
  }, []);

  const handlePickLibreOffice = useCallback(async () => {
    const selected = await open({ multiple: false });
    if (typeof selected === "string") {
      setLibreOfficePath(selected);
      try {
        localStorage.setItem("libreOfficePath", selected);
      } catch {
        // best-effort persistence only
      }
    }
  }, []);

  const handleConvertToWord = useCallback(async () => {
    if (!filePath || busy) return;
    setError(null);
    setBusy(true);
    const output = filePath.replace(/\.pdf$/i, ".docx");
    try {
      if (useLibreOffice && libreOfficePath) {
        setStatus("正在用 LibreOffice 转换为 Word...");
        await invoke("convert_to_word_libreoffice", {
          sofficePath: libreOfficePath,
          input: filePath,
          output,
        });
        setStatus(`转换完成（LibreOffice）：${output}`);
      } else {
        setStatus("正在转换为 Word...");
        await invoke("convert_to_word", { input: filePath, output });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [filePath, busy, useLibreOffice, libreOfficePath]);

  // Each tool below reads the currently loaded PDF and writes to a fixed,
  // always-overwritten scratch path (or an explicitly chosen one for
  // multi-output tools) — the original file is never touched.
  const handleRotatePreview = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_rotate", { input: filePath, output, pages: [currentPage], degrees: 90 });
      setStatus(`已生成第 ${currentPage} 页旋转预览：${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, currentPage]);

  const handleCropPreview = useCallback(async () => {
    if (!filePath || !pdfDocRef.current) return;
    setError(null);
    try {
      const page = await pdfDocRef.current.getPage(currentPage);
      const [x0, y0, x1, y1] = page.view;
      const box: [number, number, number, number] = [
        x0 + cropMargin,
        y0 + cropMargin,
        x1 - cropMargin,
        y1 - cropMargin,
      ];
      if (box[2] <= box[0] || box[3] <= box[1]) {
        setError("裁剪边距太大，页面会被裁没");
        return;
      }
      const output = scratchPreviewPath(filePath);
      await invoke("pdf_crop", { input: filePath, output, pages: [currentPage], cropBox: box });
      setStatus(`已生成第 ${currentPage} 页裁剪预览：${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, currentPage, cropMargin]);

  const handleDeletePreview = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_delete_pages", { input: filePath, output, pages: [currentPage] });
      setStatus(`已生成删除第 ${currentPage} 页后的预览：${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, currentPage]);

  const handleOfficeToPdf = useCallback(async () => {
    if (!libreOfficePath) return;
    const selected = await open({
      multiple: false,
      filters: [{ name: "Office", extensions: ["docx", "pptx", "xlsx", "doc", "ppt", "xls", "odt"] }],
    });
    if (typeof selected !== "string") return;
    setError(null);
    setBusy(true);
    setStatus("正在转换为 PDF...");
    const output = selected.replace(/\.[^./\\]+$/, ".pdf");
    try {
      await invoke("convert_office_to_pdf", { sofficePath: libreOfficePath, input: selected, output });
      setStatus(`转换完成：${output}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [libreOfficePath]);

  const handleCompress = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_compress", { input: filePath, output });
      setStatus(`已压缩，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleExportImages = useCallback(async () => {
    if (!filePath) return;
    const outDir = await open({ directory: true, multiple: false });
    if (typeof outDir !== "string") return;
    setError(null);
    try {
      await invoke("pdf_to_images", { input: filePath, outDir, format: "png", dpi: 150 });
      setStatus(`已导出到 ${outDir}`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleImagesToPdf = useCallback(async () => {
    const images = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (!images || (Array.isArray(images) && images.length === 0)) return;
    const list = Array.isArray(images) ? images : [images];
    const output = list[0].replace(/\.[^./\\]+$/, "") + ".combined.pdf";
    setError(null);
    try {
      await invoke("images_to_pdf", { output, images: list });
      setStatus(`已合并为 ${output}`);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleWatermark = useCallback(async () => {
    if (!filePath || !watermarkText) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_watermark", { input: filePath, output, text: watermarkText });
      setStatus(`已加水印，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, watermarkText]);

  const handlePageNumbers = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_page_numbers", { input: filePath, output });
      setStatus(`已加页码，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleEncrypt = useCallback(async () => {
    if (!filePath || !encryptPassword) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_encrypt", { input: filePath, output, userPassword: encryptPassword });
      setStatus(`已加密，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, encryptPassword]);

  const handleDecrypt = useCallback(async () => {
    if (!filePath || !decryptPassword) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_decrypt", { input: filePath, output, password: decryptPassword });
      setStatus(`已解密，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, decryptPassword]);

  useEffect(() => {
    const unlistenPromise = listen<ConvertProgress>("pdf-convert-progress", (event) => {
      const payload = event.payload;
      if (payload.event === "done" && payload.output) {
        setStatus(`转换完成：${payload.output}`);
      } else if (payload.event === "error" && payload.message) {
        setError(payload.message);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const webview = getCurrentWebviewWindow();
    const unlistenPromise = webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDragging(true);
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragging(false);
        const pdfPath = event.payload.paths.find((p) =>
          p.toLowerCase().endsWith(".pdf"),
        );
        if (pdfPath) {
          void loadPdf(pdfPath);
        } else {
          setError("请拖入一个 PDF 文件");
        }
        return;
      }
      setIsDragging(false);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadPdf]);

  const inputClass =
    "px-2 py-1.5 rounded bg-neutral-900 border border-neutral-700 text-neutral-200 flex-1 text-sm";
  const actionButtonClass =
    "px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 transition-colors text-sm font-medium";

  const needsFile = NEEDS_LOADED_PDF.includes(activeTool) && !filePath;

  let toolPanel: ReactNode = null;
  if (needsFile) {
    toolPanel = <p className="text-sm text-neutral-500">请先在左侧打开一个 PDF 文件</p>;
  } else if (activeTool === "convert-word") {
    toolPanel = (
      <div className="flex flex-col gap-3">
        <button onClick={handleConvertToWord} disabled={!filePath || busy} className={actionButtonClass}>
          {busy ? "转换中..." : "转换为 Word"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 cursor-pointer">
          <input
            type="checkbox"
            checked={useLibreOffice}
            disabled={!libreOfficePath}
            onChange={(e) => setUseLibreOffice(e.target.checked)}
          />
          改用 LibreOffice 转换（未在设置里配置路径则不可用）
        </label>
        {useLibreOffice && (
          <p className="text-[11px] text-amber-700/80">
            注意：LibreOffice 会把文字转成独立的文本框以保留原始排版，适合只想保留版面样式的场景，但生成的文档不便于直接编辑。
          </p>
        )}
      </div>
    );
  } else if (activeTool === "office-to-pdf") {
    toolPanel = libreOfficePath ? (
      <button onClick={handleOfficeToPdf} disabled={busy} className={actionButtonClass}>
        选择 Office 文档并转换为 PDF
      </button>
    ) : (
      <p className="text-sm text-neutral-500">
        需要先在左下角"设置"里配置 LibreOffice 路径才能使用这个工具。
      </p>
    );
  } else if (activeTool === "compress") {
    toolPanel = (
      <button onClick={handleCompress} className={actionButtonClass}>
        压缩当前 PDF
      </button>
    );
  } else if (activeTool === "watermark") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={watermarkText}
          onChange={(e) => setWatermarkText(e.target.value)}
          placeholder="水印文字"
          className={inputClass}
        />
        <button onClick={handleWatermark} className={actionButtonClass}>
          加水印
        </button>
      </div>
    );
  } else if (activeTool === "page-numbers") {
    toolPanel = (
      <button onClick={handlePageNumbers} className={actionButtonClass}>
        给每页加页码
      </button>
    );
  } else if (activeTool === "rotate") {
    toolPanel = (
      <button onClick={handleRotatePreview} className={actionButtonClass}>
        旋转第 {currentPage} 页 90°
      </button>
    );
  } else if (activeTool === "crop") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400">四周裁掉</label>
        <input
          type="number"
          min={0}
          value={cropMargin}
          onChange={(e) => setCropMargin(Number(e.target.value))}
          className={`${inputClass} flex-none w-20`}
        />
        <span className="text-sm text-neutral-400">pt</span>
        <button onClick={handleCropPreview} className={actionButtonClass}>
          裁剪第 {currentPage} 页
        </button>
      </div>
    );
  } else if (activeTool === "delete") {
    toolPanel = (
      <button onClick={handleDeletePreview} className={actionButtonClass}>
        删除第 {currentPage} 页
      </button>
    );
  } else if (activeTool === "to-images") {
    toolPanel = (
      <button onClick={handleExportImages} className={actionButtonClass}>
        选择导出目录（每页一张 PNG）
      </button>
    );
  } else if (activeTool === "from-images") {
    toolPanel = (
      <button onClick={handleImagesToPdf} className={actionButtonClass}>
        选择多张图片合并为 PDF
      </button>
    );
  } else if (activeTool === "encrypt") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={encryptPassword}
          onChange={(e) => setEncryptPassword(e.target.value)}
          placeholder="设置密码"
          className={inputClass}
        />
        <button onClick={handleEncrypt} className={actionButtonClass}>
          加密
        </button>
      </div>
    );
  } else if (activeTool === "decrypt") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={decryptPassword}
          onChange={(e) => setDecryptPassword(e.target.value)}
          placeholder="输入密码解密"
          className={inputClass}
        />
        <button onClick={handleDecrypt} className={actionButtonClass}>
          解密
        </button>
      </div>
    );
  } else if (activeTool === "settings") {
    toolPanel = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <button
            onClick={handlePickLibreOffice}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm"
          >
            {libreOfficePath ? "重新选择 LibreOffice 路径" : "选择 LibreOffice 路径"}
          </button>
        </div>
        {libreOfficePath && (
          <p className="text-[11px] text-neutral-600 break-all">{libreOfficePath}</p>
        )}
        <p className="text-[11px] text-neutral-600">
          LibreOffice 不是必需的，只有"改用 LibreOffice 转换"和"Office 转 PDF"用得到。
        </p>
      </div>
    );
  }

  const activeLabel =
    [...TOOL_GROUPS.flatMap((g) => g.items)].find((i) => i.id === activeTool)?.label ??
    (activeTool === "settings" ? "设置" : "");

  return (
    <div className="h-screen flex bg-neutral-950 text-neutral-100">
      <aside className="w-52 shrink-0 border-r border-neutral-800 flex flex-col p-3 gap-4 overflow-y-auto">
        <h1 className="text-lg font-semibold px-1">LocalPDF</h1>
        {TOOL_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-neutral-600 px-1">{group.title}</p>
            {group.items.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTool(item.id)}
                className={`text-left px-2 py-1.5 rounded-md text-sm transition-colors ${
                  activeTool === item.id
                    ? "bg-emerald-700 text-white"
                    : "text-neutral-300 hover:bg-neutral-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <div className="mt-auto">
          <button
            onClick={() => setActiveTool("settings")}
            className={`w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${
              activeTool === "settings" ? "bg-emerald-700 text-white" : "text-neutral-400 hover:bg-neutral-800"
            }`}
          >
            ⚙️ 设置
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col p-6 gap-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-neutral-300">{activeLabel}</h2>
          <button
            onClick={toggleInvertColors}
            title="护眼反色，只改变显示效果，不影响原文件"
            className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
              invertColors
                ? "bg-neutral-200 text-neutral-900 hover:bg-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {invertColors ? "☀️ 关闭反色" : "🌙 护眼反色"}
          </button>
        </div>

        {!filePath && (
          <div
            className={`rounded-xl border-2 border-dashed p-10 flex flex-col items-center gap-4 transition-colors ${
              isDragging ? "border-blue-400 bg-blue-950/30" : "border-neutral-700"
            }`}
          >
            <p className="text-neutral-400 text-sm">将 PDF 文件拖拽到此处，或者</p>
            <button
              onClick={handleOpenDialog}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors text-sm font-medium"
            >
              选择 PDF 文件
            </button>
          </div>
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}
        {status && <p className="text-green-400 text-sm">{status}</p>}

        {filePath && (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-3 text-sm text-neutral-400">
              <span className="truncate max-w-md">{filePath}</span>
              <button onClick={handleOpenDialog} className="text-xs underline underline-offset-2 hover:text-neutral-200">
                更换文件
              </button>
            </div>

            {pageCount !== null && pageCount > 0 && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void goToPage(-1)}
                  disabled={currentPage <= 1}
                  className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-30 text-xs"
                >
                  上一页
                </button>
                <span className="text-sm text-neutral-400">
                  第 {currentPage} / {pageCount} 页
                </span>
                <button
                  onClick={() => void goToPage(1)}
                  disabled={currentPage >= pageCount}
                  className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-30 text-xs"
                >
                  下一页
                </button>
              </div>
            )}

            <canvas
              ref={canvasRef}
              className="border border-neutral-800 rounded-lg shadow-lg max-w-full"
              style={invertColors ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
            />
          </div>
        )}

        <div className="mt-2 border-t border-neutral-800 pt-4">{toolPanel}</div>
      </main>
    </div>
  );
}

export default App;
