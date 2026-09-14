import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "./App.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function withSuffix(path: string, suffix: string, ext = ".pdf") {
  const base = path.replace(/\.pdf$/i, "");
  return `${base}${suffix}${ext}`;
}

type ConvertProgress = {
  event: "start" | "done" | "error";
  output?: string;
  message?: string;
};

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const loadPdf = useCallback(async (path: string) => {
    setError(null);
    try {
      const bytes = await readFile(path);
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      setPageCount(doc.numPages);
      setFilePath(path);

      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1.2 });
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: context, viewport, canvas }).promise;
    } catch (e) {
      setError(String(e));
      setPageCount(null);
      setFilePath(null);
    }
  }, []);

  const handleOpenDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected === "string") {
      await loadPdf(selected);
    }
  }, [loadPdf]);

  const handleRotate = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = withSuffix(filePath, "-rotated");
    try {
      await invoke("pdf_rotate", { input: filePath, output, pages: [1], degrees: 90 });
      setStatus(`已旋转第 1 页，保存到 ${output}`);
      await loadPdf(output);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, loadPdf]);

  const handleDeleteFirstPage = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = withSuffix(filePath, "-deleted");
    try {
      await invoke("pdf_delete_pages", { input: filePath, output, pages: [1] });
      setStatus(`已删除第 1 页，保存到 ${output}`);
      await loadPdf(output);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, loadPdf]);

  const handleConvertToWord = useCallback(async () => {
    if (!filePath || busy) return;
    setError(null);
    setBusy(true);
    setStatus("正在转换为 Word...");
    const output = withSuffix(filePath, "", ".docx");
    try {
      await invoke("convert_to_word", { input: filePath, output });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [filePath, busy]);

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
          {pageCount !== null && <p>共 {pageCount} 页</p>}
          <div className="flex gap-2">
            <button
              onClick={handleRotate}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-colors text-xs"
            >
              旋转第 1 页 90°
            </button>
            <button
              onClick={handleDeleteFirstPage}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-colors text-xs"
            >
              删除第 1 页
            </button>
            <button
              onClick={handleConvertToWord}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 transition-colors text-xs"
            >
              {busy ? "转换中..." : "转换为 Word"}
            </button>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="border border-neutral-800 rounded-lg shadow-lg max-w-full"
      />
    </main>
  );
}

export default App;
