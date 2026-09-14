import { useCallback, useEffect, useRef, useState } from "react";
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

function readStoredLibreOfficePath(): string | null {
  try {
    return localStorage.getItem("libreOfficePath");
  } catch {
    return null;
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

  // Test-only affordances for the Rust page-ops engine. They always read
  // from the original file and write to one fixed scratch path (never the
  // original, never a growing chain of "-rotated-rotated-..." files), and
  // deliberately don't touch the main viewer state.
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

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center p-8 gap-6">
      <h1 className="text-2xl font-semibold">LocalPDF</h1>

      <div
        className={`w-full max-w-2xl rounded-xl border-2 border-dashed p-10 flex flex-col items-center gap-4 transition-colors ${
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

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {status && <p className="text-green-400 text-sm">{status}</p>}

      {filePath && (
        <div className="text-sm text-neutral-400 text-center flex flex-col items-center gap-3">
          <p>{filePath}</p>

          {pageCount !== null && pageCount > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => void goToPage(-1)}
                disabled={currentPage <= 1}
                className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-30 text-xs"
              >
                上一页
              </button>
              <span>
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

          <button
            onClick={handleConvertToWord}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 transition-colors text-sm font-medium"
          >
            {busy ? "转换中..." : "转换为 Word"}
          </button>

          <div className="flex items-center gap-2 text-xs text-neutral-600">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useLibreOffice}
                disabled={!libreOfficePath}
                onChange={(e) => setUseLibreOffice(e.target.checked)}
              />
              改用 LibreOffice 转换
            </label>
            <button
              onClick={handlePickLibreOffice}
              className="hover:text-neutral-400 underline underline-offset-2"
            >
              {libreOfficePath ? "重新选择路径" : "选择 LibreOffice 路径"}
            </button>
          </div>
          {libreOfficePath && (
            <>
              <p className="text-[10px] text-neutral-700 max-w-md break-all">{libreOfficePath}</p>
              <p className="text-[10px] text-amber-700/80 max-w-md">
                注意：LibreOffice 会把文字转成独立的文本框以保留原始排版，
                适合只想保留版面样式的场景，但生成的文档不便于直接编辑。
              </p>
            </>
          )}
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="border border-neutral-800 rounded-lg shadow-lg max-w-full"
      />

      {filePath && (
        <div className="text-xs text-neutral-600 flex gap-4">
          <button
            onClick={handleRotatePreview}
            className="hover:text-neutral-400 underline underline-offset-2"
          >
            旋转当前页（引擎测试）
          </button>
          <button
            onClick={handleDeletePreview}
            className="hover:text-neutral-400 underline underline-offset-2"
          >
            删除当前页（引擎测试）
          </button>
        </div>
      )}
    </main>
  );
}

export default App;
