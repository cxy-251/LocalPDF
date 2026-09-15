import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "./App.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Fixed, always-overwritten scratch path so repeated test clicks never pile
// up new files, and the original the user dropped in is never touched.
function scratchPreviewPath(path: string) {
  return path.replace(/\.pdf$/i, ".localpdf-preview.pdf");
}

type ConvertProgress = {
  event: "start" | "done" | "error" | "progress";
  output?: string;
  message?: string;
  metadata?: Record<string, string | null>;
  toc?: [number, string, number][];
};

type ToolId =
  | "convert-word"
  | "office-to-pdf"
  | "html-to-pdf"
  | "merge"
  | "split"
  | "extract"
  | "reorder"
  | "compress"
  | "watermark"
  | "remove-watermark"
  | "page-numbers"
  | "grayscale"
  | "rotate"
  | "crop"
  | "delete"
  | "remove-blank"
  | "unify-size"
  | "to-images"
  | "from-images"
  | "extract-images"
  | "extract-text"
  | "metadata"
  | "toc"
  | "encrypt"
  | "decrypt"
  | "redact"
  | "settings";

const TOOL_GROUPS: { title: string; items: { id: ToolId; label: string }[] }[] = [
  {
    title: "转换",
    items: [
      { id: "convert-word", label: "转换为 Word" },
      { id: "office-to-pdf", label: "Office 转 PDF" },
      { id: "html-to-pdf", label: "网页转 PDF" },
    ],
  },
  {
    title: "整理页面",
    items: [
      { id: "merge", label: "合并多个 PDF" },
      { id: "split", label: "拆分为多个文件" },
      { id: "extract", label: "按页码提取" },
      { id: "reorder", label: "调整页面顺序" },
    ],
  },
  {
    title: "页面外观",
    items: [
      { id: "compress", label: "压缩" },
      { id: "watermark", label: "加水印" },
      { id: "remove-watermark", label: "去除文字水印" },
      { id: "page-numbers", label: "加页码" },
      { id: "grayscale", label: "灰度化" },
      { id: "rotate", label: "旋转当前页" },
      { id: "crop", label: "裁剪当前页" },
    ],
  },
  {
    title: "清理",
    items: [
      { id: "delete", label: "删除当前页" },
      { id: "remove-blank", label: "去除空白页" },
      { id: "unify-size", label: "统一页面尺寸" },
    ],
  },
  {
    title: "图片",
    items: [
      { id: "to-images", label: "导出为图片" },
      { id: "from-images", label: "图片合并为 PDF" },
      { id: "extract-images", label: "提取内嵌图片" },
    ],
  },
  {
    title: "文档信息",
    items: [
      { id: "extract-text", label: "提取纯文本" },
      { id: "metadata", label: "文档属性" },
      { id: "toc", label: "书签目录" },
    ],
  },
  {
    title: "安全",
    items: [
      { id: "encrypt", label: "加密" },
      { id: "decrypt", label: "解密" },
      { id: "redact", label: "永久遮盖" },
    ],
  },
];

const NEEDS_LOADED_PDF: ToolId[] = [
  "convert-word",
  "split",
  "extract",
  "reorder",
  "compress",
  "watermark",
  "remove-watermark",
  "page-numbers",
  "grayscale",
  "rotate",
  "crop",
  "delete",
  "remove-blank",
  "unify-size",
  "to-images",
  "extract-images",
  "extract-text",
  "metadata",
  "toc",
  "encrypt",
  "decrypt",
  "redact",
];

function readStoredPath(key: string): string | null {
  try {
    return localStorage.getItem(key);
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
  const [libreOfficePath, setLibreOfficePath] = useState<string | null>(() => readStoredPath("libreOfficePath"));
  const [useLibreOffice, setUseLibreOffice] = useState(false);
  const [browserPath, setBrowserPath] = useState<string | null>(() => readStoredPath("browserPath"));
  const [invertColors, setInvertColors] = useState<boolean>(readStoredInvertPreference);
  const [activeTool, setActiveTool] = useState<ToolId>("convert-word");
  const [watermarkText, setWatermarkText] = useState("CONFIDENTIAL");
  const [cropMargin, setCropMargin] = useState(20);
  const [mergeFiles, setMergeFiles] = useState<string[]>([]);
  const [extractSpec, setExtractSpec] = useState("1-");
  const [reorderSpec, setReorderSpec] = useState("");
  const [encryptPassword, setEncryptPassword] = useState("");
  const [decryptPassword, setDecryptPassword] = useState("");
  const [redactRects, setRedactRects] = useState<[number, number, number, number][]>([]);
  const [draftRect, setDraftRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [htmlUrl, setHtmlUrl] = useState("https://");
  const [splitPagesPerFile, setSplitPagesPerFile] = useState(1);
  const [removeWatermarkText, setRemoveWatermarkText] = useState("");
  const [unifyWidth, setUnifyWidth] = useState(595);
  const [unifyHeight, setUnifyHeight] = useState(842);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaAuthor, setMetaAuthor] = useState("");
  const [metaSubject, setMetaSubject] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [tocText, setTocText] = useState("[]");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const renderPage = useCallback(async (pageNum: number) => {
    const doc = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.2 });
    viewportRef.current = viewport;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const overlay = overlayCanvasRef.current;
    if (overlay) {
      overlay.width = viewport.width;
      overlay.height = viewport.height;
    }
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
        setRedactRects([]);
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
      setRedactRects([]);
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

  const handlePickBrowser = useCallback(async () => {
    const selected = await open({ multiple: false });
    if (typeof selected === "string") {
      setBrowserPath(selected);
      try {
        localStorage.setItem("browserPath", selected);
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

  const handleAddMergeFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    setMergeFiles((prev) => [...prev, ...list]);
  }, []);

  const handleRemoveMergeFile = useCallback((index: number) => {
    setMergeFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMoveMergeFile = useCallback((index: number, delta: number) => {
    setMergeFiles((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const handleMerge = useCallback(async () => {
    if (mergeFiles.length < 2) {
      setError("合并至少需要选择两个 PDF 文件");
      return;
    }
    const output = await open({
      directory: true,
      multiple: false,
      title: "选择合并结果保存的文件夹",
    });
    if (typeof output !== "string") return;
    setError(null);
    setBusy(true);
    try {
      const outputPath = `${output}/merged.pdf`;
      await invoke("pdf_merge", { inputs: mergeFiles, output: outputPath });
      setStatus(`已合并为 ${outputPath}`);
      setMergeFiles([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [mergeFiles]);

  const handleExtract = useCallback(async () => {
    if (!filePath || !extractSpec) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_extract", { input: filePath, output, pages: extractSpec });
      setStatus(`已提取到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, extractSpec]);

  const handleReorder = useCallback(async () => {
    if (!filePath || !pageCount) return;
    setError(null);
    const order = reorderSpec
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    const isValidPermutation =
      order.length === pageCount &&
      new Set(order).size === pageCount &&
      order.every((n) => n >= 1 && n <= pageCount);
    if (!isValidPermutation) {
      setError(`请输入 1 到 ${pageCount} 这 ${pageCount} 个数字的一个排列，用逗号分隔`);
      return;
    }
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_reorder", { input: filePath, output, order });
      setStatus(`已生成新顺序的预览：${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, pageCount, reorderSpec]);

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

  const handleHtmlToPdf = useCallback(async () => {
    if (!browserPath || !htmlUrl) return;
    const output = await open({
      directory: true,
      multiple: false,
      title: "选择 PDF 保存的文件夹",
    });
    if (typeof output !== "string") return;
    setError(null);
    setBusy(true);
    setStatus("正在渲染网页为 PDF...");
    const outputPath = `${output}/webpage.pdf`;
    try {
      await invoke("convert_url_to_pdf", { browserPath, url: htmlUrl, output: outputPath });
      setStatus(`转换完成：${outputPath}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [browserPath, htmlUrl]);

  const handleSplit = useCallback(async () => {
    if (!filePath) return;
    const outDir = await open({ directory: true, multiple: false });
    if (typeof outDir !== "string") return;
    setError(null);
    try {
      await invoke("pdf_split", { input: filePath, outDir, pagesPerFile: splitPagesPerFile });
      setStatus(`已拆分到 ${outDir}`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, splitPagesPerFile]);

  const handleRemoveWatermarkText = useCallback(async () => {
    if (!filePath || !removeWatermarkText) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_strip_text", { input: filePath, output, text: removeWatermarkText });
      setStatus(`已移除匹配文字，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, removeWatermarkText]);

  const handleGrayscale = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_grayscale", { input: filePath, output });
      setStatus(`已灰度化，保存到 ${output}（原文件未改动，注意文字不再可选中）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleRemoveBlankPages = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_remove_blank_pages", { input: filePath, output });
      setStatus(`已去除空白页，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleUnifyPageSize = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_unify_page_size", { input: filePath, output, width: unifyWidth, height: unifyHeight });
      setStatus(`已统一页面尺寸，保存到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, unifyWidth, unifyHeight]);

  const handleExtractText = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = filePath.replace(/\.pdf$/i, ".localpdf-extracted.txt");
    try {
      await invoke("pdf_extract_text", { input: filePath, output });
      setStatus(`已提取文本到 ${output}`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleExtractImages = useCallback(async () => {
    if (!filePath) return;
    const outDir = await open({ directory: true, multiple: false });
    if (typeof outDir !== "string") return;
    setError(null);
    try {
      await invoke("pdf_extract_images", { input: filePath, outDir });
      setStatus(`已提取内嵌图片到 ${outDir}`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleReadMetadata = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    try {
      await invoke("pdf_get_metadata", { input: filePath });
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleSaveMetadata = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_set_metadata", {
        input: filePath,
        output,
        title: metaTitle || null,
        author: metaAuthor || null,
        subject: metaSubject || null,
        keywords: metaKeywords || null,
      });
      setStatus(`已保存文档属性到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, metaTitle, metaAuthor, metaSubject, metaKeywords]);

  const handleReadToc = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    try {
      await invoke("pdf_get_toc", { input: filePath });
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  const handleSaveToc = useCallback(async () => {
    if (!filePath) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    try {
      await invoke("pdf_set_toc", { input: filePath, output, toc: tocText });
      setStatus(`已保存书签目录到 ${output}（原文件未改动）`);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, tocText]);

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

  // Redact: draw rectangles directly on an overlay canvas (in canvas pixel
  // space), converting to/from PDF point space via the page's own viewport
  // so the marked regions line up regardless of zoom/rotation.
  const drawRedactOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    const viewport = viewportRef.current;
    const ctx = overlay?.getContext("2d");
    if (!overlay || !ctx || !viewport) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.fillStyle = "rgba(220, 38, 38, 0.5)";
    ctx.strokeStyle = "rgba(220, 38, 38, 0.9)";
    for (const [x0, y0, x1, y1] of redactRects) {
      const [vx0, vy0] = viewport.convertToViewportPoint(x0, y0);
      const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
      const left = Math.min(vx0, vx1);
      const top = Math.min(vy0, vy1);
      ctx.fillRect(left, top, Math.abs(vx1 - vx0), Math.abs(vy1 - vy0));
      ctx.strokeRect(left, top, Math.abs(vx1 - vx0), Math.abs(vy1 - vy0));
    }
    if (draftRect) {
      const left = Math.min(draftRect.x0, draftRect.x1);
      const top = Math.min(draftRect.y0, draftRect.y1);
      ctx.strokeRect(left, top, Math.abs(draftRect.x1 - draftRect.x0), Math.abs(draftRect.y1 - draftRect.y0));
    }
  }, [redactRects, draftRect]);

  useEffect(() => {
    drawRedactOverlay();
  }, [drawRedactOverlay]);

  const overlayPointFromEvent = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handleRedactMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const point = overlayPointFromEvent(e);
      if (!point) return;
      dragStartRef.current = point;
      setDraftRect({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    },
    [overlayPointFromEvent],
  );

  const handleRedactMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (!dragStartRef.current) return;
      const point = overlayPointFromEvent(e);
      if (!point) return;
      setDraftRect({ x0: dragStartRef.current.x, y0: dragStartRef.current.y, x1: point.x, y1: point.y });
    },
    [overlayPointFromEvent],
  );

  const handleRedactMouseUp = useCallback(() => {
    const viewport = viewportRef.current;
    if (!dragStartRef.current || !draftRect || !viewport) {
      dragStartRef.current = null;
      setDraftRect(null);
      return;
    }
    const [px0, py0] = viewport.convertToPdfPoint(draftRect.x0, draftRect.y0);
    const [px1, py1] = viewport.convertToPdfPoint(draftRect.x1, draftRect.y1);
    const rect: [number, number, number, number] = [
      Math.min(px0, px1),
      Math.min(py0, py1),
      Math.max(px0, px1),
      Math.max(py0, py1),
    ];
    const isMeaningfulSize = rect[2] - rect[0] > 2 && rect[3] - rect[1] > 2;
    if (isMeaningfulSize) {
      setRedactRects((prev) => [...prev, rect]);
    }
    dragStartRef.current = null;
    setDraftRect(null);
  }, [draftRect]);

  const handleApplyRedaction = useCallback(async () => {
    if (!filePath || redactRects.length === 0) return;
    setError(null);
    const output = scratchPreviewPath(filePath);
    const regions = [{ page: currentPage - 1, rects: redactRects }];
    try {
      await invoke("pdf_redact", { input: filePath, output, regions: JSON.stringify(regions) });
      setStatus(`已永久遮盖并保存到 ${output}（原文件未改动）`);
      setRedactRects([]);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath, currentPage, redactRects]);

  useEffect(() => {
    const unlistenPromise = listen<ConvertProgress>("pdf-convert-progress", (event) => {
      const payload = event.payload;
      if (payload.metadata) {
        setMetaTitle(payload.metadata.title ?? "");
        setMetaAuthor(payload.metadata.author ?? "");
        setMetaSubject(payload.metadata.subject ?? "");
        setMetaKeywords(payload.metadata.keywords ?? "");
      } else if (payload.toc) {
        setTocText(JSON.stringify(payload.toc, null, 2));
      } else if (payload.event === "done" && payload.output) {
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
  } else if (activeTool === "html-to-pdf") {
    toolPanel = browserPath ? (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={htmlUrl}
          onChange={(e) => setHtmlUrl(e.target.value)}
          placeholder="https://example.com"
          className={inputClass}
        />
        <button onClick={handleHtmlToPdf} disabled={busy} className={actionButtonClass}>
          渲染为 PDF
        </button>
      </div>
    ) : (
      <p className="text-sm text-neutral-500">
        需要先在左下角"设置"里配置 Chrome/Edge 路径才能使用这个工具。
      </p>
    );
  } else if (activeTool === "merge") {
    toolPanel = (
      <div className="flex flex-col gap-3">
        <button onClick={handleAddMergeFiles} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm self-start">
          添加 PDF 文件
        </button>
        {mergeFiles.length > 0 && (
          <ul className="flex flex-col gap-1">
            {mergeFiles.map((f, i) => (
              <li key={`${f}-${i}`} className="flex items-center gap-2 text-sm text-neutral-300 bg-neutral-900 rounded px-2 py-1">
                <span className="truncate flex-1">{f}</span>
                <button onClick={() => handleMoveMergeFile(i, -1)} disabled={i === 0} className="text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30">
                  上移
                </button>
                <button onClick={() => handleMoveMergeFile(i, 1)} disabled={i === mergeFiles.length - 1} className="text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30">
                  下移
                </button>
                <button onClick={() => handleRemoveMergeFile(i)} className="text-xs text-red-400 hover:text-red-300">
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={handleMerge} disabled={mergeFiles.length < 2 || busy} className={`${actionButtonClass} self-start`}>
          按上面顺序合并
        </button>
      </div>
    );
  } else if (activeTool === "split") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400">每份页数</label>
        <input
          type="number"
          min={1}
          value={splitPagesPerFile}
          onChange={(e) => setSplitPagesPerFile(Math.max(1, Number(e.target.value)))}
          className={`${inputClass} flex-none w-20`}
        />
        <button onClick={handleSplit} className={actionButtonClass}>
          选择文件夹并拆分
        </button>
      </div>
    );
  } else if (activeTool === "extract") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400">页码</label>
        <input
          type="text"
          value={extractSpec}
          onChange={(e) => setExtractSpec(e.target.value)}
          placeholder="如 1-3,5,8-10"
          className={inputClass}
        />
        <button onClick={handleExtract} className={actionButtonClass}>
          提取
        </button>
      </div>
    );
  } else if (activeTool === "reorder") {
    toolPanel = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-neutral-400">新顺序</label>
          <input
            type="text"
            value={reorderSpec}
            onChange={(e) => setReorderSpec(e.target.value)}
            placeholder={pageCount ? `如 ${Array.from({ length: pageCount }, (_, i) => pageCount - i).join(",")}` : ""}
            className={inputClass}
          />
          <button onClick={handleReorder} className={actionButtonClass}>
            重新排序
          </button>
        </div>
        <p className="text-[11px] text-neutral-600">
          按新的页面顺序填入原页码，用逗号分隔，共 {pageCount ?? 0} 个数字，每个 1-{pageCount ?? 0} 只能出现一次。
        </p>
      </div>
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
  } else if (activeTool === "remove-watermark") {
    toolPanel = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={removeWatermarkText}
            onChange={(e) => setRemoveWatermarkText(e.target.value)}
            placeholder="要移除的文字（需要完全匹配）"
            className={inputClass}
          />
          <button onClick={handleRemoveWatermarkText} className={actionButtonClass}>
            移除
          </button>
        </div>
        <p className="text-[11px] text-neutral-600">
          只能移除文字型水印，且需要你输入准确的文字内容；图片/扫描件里的水印无法用这个方式去除。
        </p>
      </div>
    );
  } else if (activeTool === "page-numbers") {
    toolPanel = (
      <button onClick={handlePageNumbers} className={actionButtonClass}>
        给每页加页码
      </button>
    );
  } else if (activeTool === "grayscale") {
    toolPanel = (
      <div className="flex flex-col gap-2">
        <button onClick={handleGrayscale} className={`${actionButtonClass} self-start`}>
          灰度化整个文档
        </button>
        <p className="text-[11px] text-neutral-600">
          会把每页转成灰度图片，文字将不再可选中/可搜索——这是真正灰度化和保留可编辑文字之间的权衡。
        </p>
      </div>
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
  } else if (activeTool === "remove-blank") {
    toolPanel = (
      <button onClick={handleRemoveBlankPages} className={actionButtonClass}>
        去除空白页
      </button>
    );
  } else if (activeTool === "unify-size") {
    toolPanel = (
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400">宽</label>
        <input
          type="number"
          min={1}
          value={unifyWidth}
          onChange={(e) => setUnifyWidth(Number(e.target.value))}
          className={`${inputClass} flex-none w-20`}
        />
        <label className="text-sm text-neutral-400">高</label>
        <input
          type="number"
          min={1}
          value={unifyHeight}
          onChange={(e) => setUnifyHeight(Number(e.target.value))}
          className={`${inputClass} flex-none w-20`}
        />
        <span className="text-sm text-neutral-400">pt（默认 A4）</span>
        <button onClick={handleUnifyPageSize} className={actionButtonClass}>
          统一
        </button>
      </div>
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
  } else if (activeTool === "extract-images") {
    toolPanel = (
      <button onClick={handleExtractImages} className={actionButtonClass}>
        选择导出目录并提取内嵌图片
      </button>
    );
  } else if (activeTool === "extract-text") {
    toolPanel = (
      <button onClick={handleExtractText} className={actionButtonClass}>
        提取纯文本到 .txt
      </button>
    );
  } else if (activeTool === "metadata") {
    toolPanel = (
      <div className="flex flex-col gap-2 max-w-md">
        <button onClick={handleReadMetadata} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm self-start">
          读取当前文档属性
        </button>
        <input value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} placeholder="标题" className={inputClass} />
        <input value={metaAuthor} onChange={(e) => setMetaAuthor(e.target.value)} placeholder="作者" className={inputClass} />
        <input value={metaSubject} onChange={(e) => setMetaSubject(e.target.value)} placeholder="主题" className={inputClass} />
        <input value={metaKeywords} onChange={(e) => setMetaKeywords(e.target.value)} placeholder="关键词" className={inputClass} />
        <button onClick={handleSaveMetadata} className={`${actionButtonClass} self-start`}>
          保存
        </button>
      </div>
    );
  } else if (activeTool === "toc") {
    toolPanel = (
      <div className="flex flex-col gap-2 max-w-md">
        <button onClick={handleReadToc} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm self-start">
          读取当前书签目录
        </button>
        <textarea
          value={tocText}
          onChange={(e) => setTocText(e.target.value)}
          rows={8}
          placeholder='[[1, "第一章", 1], [1, "第二章", 5]]'
          className={`${inputClass} font-mono text-xs`}
        />
        <p className="text-[11px] text-neutral-600">格式：[层级, 标题, 页码] 的数组，页码从 1 开始。</p>
        <button onClick={handleSaveToc} className={`${actionButtonClass} self-start`}>
          保存
        </button>
      </div>
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
  } else if (activeTool === "redact") {
    toolPanel = (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-neutral-400">
          在上面的预览图上拖拽鼠标框选要永久移除的区域（可以框多个），确认后点"应用遮盖"——这会真的删除该区域下的文字/图片，不是画个黑框盖住。
        </p>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">已标记 {redactRects.length} 处</span>
          <button
            onClick={() => setRedactRects([])}
            disabled={redactRects.length === 0}
            className="text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
          >
            清除标记
          </button>
          <button
            onClick={handleApplyRedaction}
            disabled={redactRects.length === 0}
            className={actionButtonClass}
          >
            应用遮盖（第 {currentPage} 页）
          </button>
        </div>
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

        <div className="flex items-center gap-2 text-xs text-neutral-500 mt-2">
          <button
            onClick={handlePickBrowser}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm"
          >
            {browserPath ? "重新选择 Chrome/Edge 路径" : "选择 Chrome/Edge 路径"}
          </button>
        </div>
        {browserPath && <p className="text-[11px] text-neutral-600 break-all">{browserPath}</p>}
        <p className="text-[11px] text-neutral-600">
          只有"网页转 PDF"用得到，不打包浏览器，用你系统上已装的 Chrome 或 Edge。
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

            <div className="relative inline-block max-w-full leading-none">
              <canvas
                ref={canvasRef}
                className="border border-neutral-800 rounded-lg shadow-lg max-w-full block"
                style={invertColors ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
              />
              <canvas
                ref={overlayCanvasRef}
                onMouseDown={handleRedactMouseDown}
                onMouseMove={handleRedactMouseMove}
                onMouseUp={handleRedactMouseUp}
                onMouseLeave={handleRedactMouseUp}
                className="absolute inset-0 w-full h-full"
                style={{
                  pointerEvents: activeTool === "redact" ? "auto" : "none",
                  cursor: activeTool === "redact" ? "crosshair" : "default",
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-2 border-t border-neutral-800 pt-4">{toolPanel}</div>
      </main>
    </div>
  );
}

export default App;
