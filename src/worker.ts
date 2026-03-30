// MuPDF Web Worker — thin dispatcher
// All handler logic lives in ./worker/handlers-*.ts
import { createWorkerResponder } from "./worker-rpc";
import type { WorkerRequest } from "./types";

// Handler imports
import { handleOpen, handleGetPageCount, handleGetPageInfo, handleRenderPage, handleRotatePage, handleDeletePages, handleRearrangePages, handleInsertBlankPage, handleCreateBlankDocument, handleSave } from "./worker/handlers-document";
import {
  handleGetAnnotations, handleGetWidgets,
  handleSetAnnotRect, handleSetAnnotColor, handleSetAnnotContents,
  handleSetAnnotOpacity, handleSetAnnotBorderWidth, handleSetAnnotBorderStyle,
  handleSetAnnotInteriorColor, handleSetAnnotDefaultAppearance, handleSetAnnotIcon,
  handleSetAnnotQuadPoints, handleDeleteAnnot, handleSetWidgetValue, handleCreateAnnot,
} from "./worker/handlers-annotations";
import { handleAddImage, handleGetPageImages, handleExportImage, handleMoveResizeImage, handleDeleteImage, handleRestoreImageBlock, handleReorderImage } from "./worker/handlers-images";
import { handleExtractText, handleReplaceTextInStream, handleReplaceTextSmart, handleSearchText } from "./worker/handlers-text";

const respond = createWorkerResponder(self);

self.onmessage = async function (e: MessageEvent) {
  const { _rpcId, ...request } = e.data as WorkerRequest & { _rpcId?: number };

  try {
    switch (request.type) {
      // Document lifecycle
      case "open": return handleOpen(request, respond, _rpcId);
      case "getPageCount": return handleGetPageCount(respond, _rpcId);
      case "getPageInfo": return handleGetPageInfo(request, respond, _rpcId);
      case "renderPage": return await handleRenderPage(request, respond, _rpcId);
      case "rotatePage": return handleRotatePage(request, respond, _rpcId);
      case "deletePages": return handleDeletePages(request, respond, _rpcId);
      case "rearrangePages": return handleRearrangePages(request, respond, _rpcId);
      case "insertBlankPage": return handleInsertBlankPage(request, respond, _rpcId);
      case "createBlankDocument": return handleCreateBlankDocument(request, respond, _rpcId);
      case "save": return handleSave(request, respond, _rpcId);

      // Annotations
      case "getAnnotations": return handleGetAnnotations(request, respond, _rpcId);
      case "getWidgets": return handleGetWidgets(request, respond, _rpcId);
      case "setAnnotRect": return handleSetAnnotRect(request, respond, _rpcId);
      case "setAnnotColor": return handleSetAnnotColor(request, respond, _rpcId);
      case "setAnnotContents": return handleSetAnnotContents(request, respond, _rpcId);
      case "setAnnotOpacity": return handleSetAnnotOpacity(request, respond, _rpcId);
      case "setAnnotBorderWidth": return handleSetAnnotBorderWidth(request, respond, _rpcId);
      case "setAnnotBorderStyle": return handleSetAnnotBorderStyle(request, respond, _rpcId);
      case "setAnnotInteriorColor": return handleSetAnnotInteriorColor(request, respond, _rpcId);
      case "setAnnotDefaultAppearance": return handleSetAnnotDefaultAppearance(request, respond, _rpcId);
      case "setAnnotIcon": return handleSetAnnotIcon(request, respond, _rpcId);
      case "setAnnotQuadPoints": return handleSetAnnotQuadPoints(request, respond, _rpcId);
      case "deleteAnnot": return handleDeleteAnnot(request, respond, _rpcId);
      case "setWidgetValue": return handleSetWidgetValue(request, respond, _rpcId);
      case "createAnnot": return handleCreateAnnot(request, respond, _rpcId);

      // Images
      case "addImage": return handleAddImage(request, respond, _rpcId);
      case "getPageImages": return handleGetPageImages(request, respond, _rpcId);
      case "exportImage": return await handleExportImage(request, respond, _rpcId);
      case "moveResizeImage": return handleMoveResizeImage(request, respond, _rpcId);
      case "deleteImage": return handleDeleteImage(request, respond, _rpcId);
      case "restoreImageBlock": return handleRestoreImageBlock(request, respond, _rpcId);
      case "reorderImage": return handleReorderImage(request, respond, _rpcId);

      // Text
      case "extractText": return handleExtractText(request, respond, _rpcId);
      case "replaceTextInStream": return handleReplaceTextInStream(request, respond, _rpcId);
      case "replaceTextSmart": return await handleReplaceTextSmart(request, respond, _rpcId);
      case "searchText": return handleSearchText(request, respond, _rpcId);

      default:
        respond(_rpcId, { type: "error", message: `Unknown request type: ${(request as any).type}` });
    }
  } catch (err: any) {
    respond(_rpcId, { type: "error", message: err?.message || String(err), requestType: request.type });
  }
};
