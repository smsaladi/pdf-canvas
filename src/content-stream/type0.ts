// Type0/Identity-H hex glyph replacement and ToUnicode CMap parsing

/**
 * Parse a PDF ToUnicode CMap stream to build GID↔Unicode mappings.
 */
export function parseToUnicodeCMap(cmapData: string): { gidToUnicode: Map<number, string>; unicodeToGid: Map<string, number> } {
  const gidToUnicode = new Map<number, string>();
  const unicodeToGid = new Map<string, number>();

  const bfcharSections = cmapData.match(/beginbfchar\s*([\s\S]*?)endbfchar/g) || [];
  for (const section of bfcharSections) {
    for (const [, gidHex, uniHex] of section.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const gid = parseInt(gidHex, 16);
      const ch = String.fromCharCode(parseInt(uniHex, 16));
      gidToUnicode.set(gid, ch);
      unicodeToGid.set(ch, gid);
    }
  }

  const bfrangeSections = cmapData.match(/beginbfrange\s*([\s\S]*?)endbfrange/g) || [];
  for (const section of bfrangeSections) {
    for (const [, startHex, endHex, uniStartHex] of section.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const startGid = parseInt(startHex, 16);
      const endGid = parseInt(endHex, 16);
      let uniCode = parseInt(uniStartHex, 16);
      for (let gid = startGid; gid <= endGid; gid++) {
        const ch = String.fromCharCode(uniCode);
        gidToUnicode.set(gid, ch);
        unicodeToGid.set(ch, gid);
        uniCode++;
      }
    }
  }

  return { gidToUnicode, unicodeToGid };
}

/**
 * Replace text in a Type0/Identity-H content stream where text is encoded
 * as hex glyph IDs.
 */
export function replaceHexTextInStream(
  stream: string,
  oldText: string,
  newText: string,
  gidToUnicode: Map<number, string>,
  unicodeToGid: Map<string, number>,
  lineContext?: string,
  selectionY?: number,
): { result: string; count: number; missingChars: string[] } {
  const missingChars: string[] = [];
  for (const ch of new Set(newText)) {
    if (!unicodeToGid.has(ch)) missingChars.push(ch);
  }

  interface HexOp { gid: number; char: string; hexStart: number; hexEnd: number; }
  interface TextBlock { blockStart: number; blockEnd: number; yPos: number; hexOps: HexOp[]; decoded: string; }

  const blocks: TextBlock[] = [];
  const btPattern = /BT\b([\s\S]*?)ET\b/g;
  let btMatch;

  while ((btMatch = btPattern.exec(stream)) !== null) {
    const blockContent = btMatch[1];
    const blockStart = btMatch.index;
    const blockEnd = btMatch.index + btMatch[0].length;

    let yPos = 0;
    const tmMatch = blockContent.match(/[\d.e+-]+\s+[\d.e+-]+\s+[\d.e+-]+\s+[\d.e+-]+\s+([\d.e+-]+)\s+([\d.e+-]+)\s+Tm/);
    if (tmMatch) yPos = parseFloat(tmMatch[2]);

    const hexOps: HexOp[] = [];
    const hexPattern = /<([0-9A-Fa-f]{4})>\s*Tj/g;
    let hm;
    while ((hm = hexPattern.exec(blockContent)) !== null) {
      const gid = parseInt(hm[1], 16);
      const absStart = blockStart + (btMatch[0].indexOf(blockContent)) + hm.index + 1;
      hexOps.push({
        gid,
        char: gidToUnicode.get(gid) || "",
        hexStart: absStart,
        hexEnd: absStart + 4,
      });
    }

    if (hexOps.length > 0) {
      blocks.push({ blockStart, blockEnd, yPos, hexOps, decoded: hexOps.map(o => o.char).join("") });
    }
  }

  if (blocks.length === 0) return { result: stream, count: 0, missingChars };

  let targetBlock: TextBlock | null = null;
  let targetOffset = -1;

  // Strategy 1: Match full line context within a block
  if (lineContext && lineContext.length > oldText.length) {
    for (const block of blocks) {
      const lineIdx = block.decoded.indexOf(lineContext);
      if (lineIdx !== -1) {
        const oldIdx = lineContext.indexOf(oldText);
        if (oldIdx !== -1) {
          targetBlock = block;
          targetOffset = lineIdx + oldIdx;
          break;
        }
      }
    }
  }

  // Strategy 2: Use y-coordinate to disambiguate
  if (!targetBlock && selectionY !== undefined) {
    const candidates = blocks.filter(b => b.decoded.includes(oldText));
    if (candidates.length > 0) {
      candidates.sort((a, b) => Math.abs(a.yPos - selectionY) - Math.abs(b.yPos - selectionY));
      targetBlock = candidates[0];
      targetOffset = targetBlock.decoded.indexOf(oldText);
    }
  }

  // Strategy 3: Fallback — first block containing oldText
  if (!targetBlock) {
    for (const block of blocks) {
      const idx = block.decoded.indexOf(oldText);
      if (idx !== -1) {
        targetBlock = block;
        targetOffset = idx;
        break;
      }
    }
  }

  if (!targetBlock || targetOffset === -1) return { result: stream, count: 0, missingChars };

  console.log(`[Type0] Matched in block at y=${targetBlock.yPos}, decoded="${targetBlock.decoded.substring(0, 40)}", offset=${targetOffset}`);

  const hexOps = targetBlock.hexOps;
  const matchStartIdx = targetOffset;

  let result = stream;
  let offset = 0;
  const spaceGid = unicodeToGid.get(" ");

  // Phase 1: Replace existing hex operators
  for (let i = 0; i < oldText.length; i++) {
    const op = hexOps[matchStartIdx + i];
    let newHex: string;

    if (i < newText.length) {
      const gid = unicodeToGid.get(newText[i]);
      if (gid !== undefined) {
        newHex = gid.toString(16).padStart(4, "0");
      } else continue;
    } else {
      if (spaceGid !== undefined) {
        newHex = spaceGid.toString(16).padStart(4, "0");
      } else continue;
    }

    result = result.slice(0, op.hexStart + offset) + newHex + result.slice(op.hexEnd + offset);
  }

  // Phase 2: Insert new operators if replacement is longer
  if (newText.length > oldText.length) {
    const lastOp = hexOps[matchStartIdx + oldText.length - 1];
    const afterLastOp = stream.slice(lastOp.hexEnd);
    const tjEnd = afterLastOp.match(/>\s*Tj/);
    const insertPoint = lastOp.hexEnd + (tjEnd ? tjEnd.index! + tjEnd[0].length : 5);

    let charAdvance = 5;
    const lastMatchedOp = hexOps[matchStartIdx + oldText.length - 1];
    const beforeLast = stream.slice(Math.max(0, lastMatchedOp.hexStart - 40), lastMatchedOp.hexStart);
    const lastTdMatch = beforeLast.match(/([\d.]+)\s+0\s+Td\s*$/);
    if (lastTdMatch) {
      charAdvance = parseFloat(lastTdMatch[1]);
    } else {
      for (let i = matchStartIdx + oldText.length - 1; i >= matchStartIdx; i--) {
        const before = stream.slice(Math.max(0, hexOps[i].hexStart - 40), hexOps[i].hexStart);
        const tdM = before.match(/([\d.]+)\s+0\s+Td\s*$/);
        if (tdM) { charAdvance = parseFloat(tdM[1]); break; }
      }
    }

    let extra = "";
    for (let i = oldText.length; i < newText.length; i++) {
      const gid = unicodeToGid.get(newText[i]);
      if (gid !== undefined) {
        const hex = gid.toString(16).padStart(4, "0");
        extra += `\n${charAdvance} 0 Td <${hex}> Tj`;
      }
    }

    if (extra) {
      result = result.slice(0, insertPoint + offset) + extra + result.slice(insertPoint + offset);
      offset += extra.length;
    }
  }

  return { result, count: 1, missingChars };
}
