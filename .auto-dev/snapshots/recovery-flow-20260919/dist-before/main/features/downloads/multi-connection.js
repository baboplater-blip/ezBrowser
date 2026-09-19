"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canRangeRequest = canRangeRequest;
exports.probeUrl = probeUrl;
exports.startAcceleratedDownload = startAcceleratedDownload;
exports.resumeAcceleratedDownload = resumeAcceleratedDownload;
exports.pauseJob = pauseJob;
exports.resumeJob = resumeJob;
exports.cancelJob = cancelJob;
exports.metaFromJob = metaFromJob;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_fs_2 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const MAX_RETRIES_PER_SEGMENT = 3;
const RETRY_BACKOFF_MS = 800;
const DEFAULT_CONNECTIONS = 4;
const MIN_SEGMENT_BYTES = 1024 * 1024; // 1MB — 너무 작으면 단일 커넥션이 더 빠름
function canRangeRequest(headers, totalBytes) {
    const accept = (headers['accept-ranges'] ?? headers['Accept-Ranges'] ?? '').toLowerCase();
    if (accept !== 'bytes')
        return false;
    if (totalBytes < MIN_SEGMENT_BYTES)
        return false;
    return true;
}
function headersToObject(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? '') : String(v ?? '');
    }
    return out;
}
/** 요청에 커스텀 헤더 적용(Range·Host 는 내부 제어이므로 제외). */
function applyHeaders(req, headers) {
    if (!headers)
        return;
    for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (!v || lk === 'range' || lk === 'host' || lk === 'content-length')
            continue;
        try {
            req.setHeader(k, v);
        }
        catch { /* ignore */ }
    }
}
function probeOnce(args) {
    return new Promise((resolve) => {
        const req = electron_1.net.request({
            url: args.url, method: args.method, session: args.session, useSessionCookies: true,
        });
        applyHeaders(req, args.headers);
        // GET 폴백 시엔 1바이트만 받아 content-type·range 지원만 확인하고 끊는다(대용량 본문 안 받음).
        if (args.method === 'GET') {
            try {
                req.setHeader('Range', 'bytes=0-0');
            }
            catch { /* ignore */ }
        }
        let settled = false;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                req.abort();
            }
            catch { /* ignore */ }
            resolve(r);
        };
        const timer = setTimeout(() => finish({ ok: false, totalBytes: 0, acceptsRanges: false }), 6000);
        req.on('response', (resp) => {
            // probe 에 필요한 정보는 전부 응답 헤더에 있으므로 본문을 기다리지 않고 즉시 확정.
            // (finish 내부에서 req.abort 로 1바이트 본문/HEAD 커넥션을 정리한다)
            const headers = headersToObject(resp.headers);
            const status = resp.statusCode;
            const contentType = headers['content-type'] ?? '';
            // Content-Range: bytes 0-0/12345 → 전체 크기. 아니면 Content-Length.
            let totalBytes = 0;
            const cr = headers['content-range'] ?? '';
            const crm = /\/(\d+)\s*$/.exec(cr);
            if (crm && crm[1])
                totalBytes = parseInt(crm[1], 10) || 0;
            if (!totalBytes)
                totalBytes = parseInt(headers['content-length'] ?? '0', 10) || 0;
            // 206 이면 Range 를 honor 한 것 → ranges 지원. 아니면 Accept-Ranges 헤더로 판단.
            const acceptsRanges = status === 206 || (headers['accept-ranges'] ?? '').toLowerCase() === 'bytes';
            let filename;
            const disp = headers['content-disposition'] ?? '';
            const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(disp);
            if (m && m[1]) {
                try {
                    filename = decodeURIComponent(m[1]);
                }
                catch {
                    filename = m[1];
                }
            }
            finish({ ok: status >= 200 && status < 400, totalBytes, acceptsRanges, filename, contentType });
        });
        req.on('error', () => finish({ ok: false, totalBytes: 0, acceptsRanges: false }));
        req.end();
    });
}
/**
 * Content-Length·Accept-Ranges·Content-Type 조회.
 * HEAD 를 막거나(405) content-type 을 안 주는 서버 대비, 실패·불충분 시 Range GET(0-0) 으로 재시도.
 * content-type 은 "받으려는 URL 이 실제 미디어인지 vs HTML 페이지인지" 판별에 쓰인다.
 */
async function probeUrl(args) {
    const head = await probeOnce({ ...args, method: 'HEAD' });
    // HEAD 가 실패했거나 content-type 을 안 줬으면 GET(0-0) 으로 확인
    if (!head.ok || !head.contentType) {
        const get = await probeOnce({ ...args, method: 'GET' });
        // GET 이 더 풍부하면 GET 결과 우선(특히 content-type)
        if (get.ok)
            return get;
        return head.ok ? head : get;
    }
    return head;
}
function splitRanges(totalBytes, connections) {
    const n = Math.max(2, Math.min(connections, 8));
    const segSize = Math.floor(totalBytes / n);
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const start = i * segSize;
        const end = i === n - 1 ? totalBytes - 1 : (start + segSize - 1);
        out.push({ start, end });
    }
    return out;
}
function tickSpeed(job) {
    const now = Date.now();
    const dt = (now - job.lastTickAt) / 1000;
    if (dt < 0.2)
        return;
    const db = job.receivedBytes - job.lastTickBytes;
    job.speed = db / dt;
    job.lastTickAt = now;
    job.lastTickBytes = job.receivedBytes;
}
function downloadSegmentOnce(job, seg) {
    return new Promise((resolve, reject) => {
        const req = electron_1.net.request({
            url: job.url, method: 'GET', session: job.session, useSessionCookies: true,
        });
        applyHeaders(req, job.headers);
        req.setHeader('Range', `bytes=${seg.start + seg.received}-${seg.end}`);
        seg.request = req;
        let lastBroadcast = 0;
        req.on('response', (resp) => {
            // 멀티 세그먼트 다운로드는 항상 ≥2 세그먼트(splitRanges)라 각 세그먼트는 파일의 부분 범위다.
            // 206(Partial Content)만 유효하다. 서버가 Range 를 무시하고 200(전체 본문)을 돌려주면 그 본문은
            // 파일 전체이므로 .part 에 그대로 쓰면 merge 시 각 세그먼트가 전체 복사본이 되어 파일이 깨진다.
            // → 200 을 포함한 비-206 응답은 거부하고 재시도 루프에 맡긴다(잘못된 병합보다 실패가 안전).
            if (resp.statusCode !== 206) {
                console.warn(`[downloads] segment ${seg.index} HTTP ${resp.statusCode} (206 기대, hasReferer=${!!job.headers?.Referer})`);
                try {
                    req.abort();
                }
                catch { /* ignore */ }
                reject(new Error(`segment ${seg.index} HTTP ${resp.statusCode} (206 아님)`));
                return;
            }
            // 스트림은 응답 상태 확인 후 연다 — received>0 면 append(이어받기), 아니면 새로 씀.
            seg.stream = (0, node_fs_2.createWriteStream)(seg.tempPath, { flags: seg.received > 0 ? 'a' : 'w' });
            // write 스트림 오류(디스크 풀·권한·경로 없음)를 잡지 않으면 'error' 이벤트가
            // uncaughtException 으로 프로세스를 죽인다 → reject 로 재시도/실패 경로에 넘긴다.
            seg.stream.on('error', (err) => {
                try {
                    req.abort();
                }
                catch { /* ignore */ }
                reject(err);
            });
            resp.on('data', (chunk) => {
                seg.received += chunk.length;
                job.receivedBytes += chunk.length;
                seg.stream?.write(chunk);
                const now = Date.now();
                if (now - lastBroadcast > 250) {
                    lastBroadcast = now;
                    tickSpeed(job);
                    job.onUpdate(job);
                }
            });
            resp.on('end', () => {
                seg.done = true;
                seg.stream?.end(() => resolve());
            });
            resp.on('error', (err) => {
                seg.stream?.end();
                reject(err);
            });
        });
        req.on('error', (err) => {
            seg.stream?.end();
            reject(err);
        });
        req.on('abort', () => {
            seg.stream?.end();
            reject(new Error('aborted'));
        });
        req.end();
    });
}
// 재시도 직전 실제 .part 파일 크기로 seg.received 를 보정한다. seg.received 는 data 청크마다 증가하지만
// write 내구화 전이라, 스트림 error 로 중단되면 카운터가 디스크보다 커질 수 있다. 그대로 Range=start+received
// 로 이어받으면 파일 중간에 갭이 생겨 병합 결과가 손상된다(완료검사가 파일이 아닌 카운터를 봐 통과) → 실크기로 정렬.
async function syncSegmentReceived(job, seg) {
    const segSize = seg.end - seg.start + 1;
    let onDisk = 0;
    try {
        onDisk = Math.min((await node_fs_1.promises.stat(seg.tempPath)).size, segSize);
    }
    catch {
        onDisk = 0;
    }
    if (onDisk !== seg.received) {
        job.receivedBytes += onDisk - seg.received; // 집계(진행률)도 실제 디스크 기준으로 보정
        seg.received = onDisk;
    }
}
async function downloadSegment(job, seg) {
    // resume on disconnect: 최대 N회 재시도, 지수 backoff
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_RETRIES_PER_SEGMENT; attempt += 1) {
        const s = job.state;
        if (s === 'cancelled' || s === 'paused')
            throw new Error(s);
        if (attempt > 0)
            await syncSegmentReceived(job, seg); // 재시도 전 실제 파일 크기로 정렬(갭·손상 방지)
        try {
            await downloadSegmentOnce(job, seg);
            return;
        }
        catch (err) {
            lastErr = err;
            const cur = job.state;
            // 사용자 취소/일시정지면 즉시 종료 (재시도 없음)
            if (cur === 'cancelled' || cur === 'paused')
                throw err;
            if (attempt < MAX_RETRIES_PER_SEGMENT - 1) {
                await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function mergeSegments(job) {
    job.state = 'merging';
    job.onUpdate(job);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(job.savePath), { recursive: true });
    // stream pipe — 대용량 파일에서도 메모리 일정 (read 청크 단위)
    const finalStream = (0, node_fs_2.createWriteStream)(job.savePath, { flags: 'w' });
    try {
        for (const seg of job.segments) {
            // 세그먼트 크기만큼만 읽는다 — 이어받기 중 append 오산정 등으로 .part 가 범위보다 커졌어도
            // 초과분이 다음 세그먼트 앞에 끼어 파일이 깨지는 것을 막는다(end 는 inclusive).
            const segSize = seg.end - seg.start + 1;
            const src = (0, node_fs_2.createReadStream)(seg.tempPath, { start: 0, end: segSize - 1 });
            await new Promise((resolve, reject) => {
                // src(읽기)·finalStream(쓰기) 어느 쪽 오류든 잡아 reject — 안 잡으면 'error' 가
                // uncaughtException 으로 프로세스를 죽인다(디스크 풀 등).
                const cleanup = () => { src.off('error', onErr); finalStream.off('error', onErr); src.off('end', onEnd); };
                const onErr = (err) => { cleanup(); reject(err); };
                const onEnd = () => { cleanup(); resolve(); };
                src.on('error', onErr);
                finalStream.on('error', onErr);
                src.on('end', onEnd);
                src.pipe(finalStream, { end: false });
            });
        }
    }
    finally {
        await new Promise((resolve) => finalStream.end(() => resolve()));
    }
    // 임시 파일 정리
    for (const seg of job.segments) {
        try {
            await node_fs_1.promises.unlink(seg.tempPath);
        }
        catch { /* ignore */ }
    }
}
async function runJob(job) {
    // 이미 실행 중이면(예: 병합 도중 resume) 재진입을 막는다 — 두 번째 mergeSegments 가
    // 최종 파일을 동시에 쓰면 파일이 깨지고 onComplete 가 두 번 불린다.
    if (job.running)
        return;
    job.running = true;
    try {
        // 세그먼트 임시 파일(.part<i>)과 최종 파일이 놓일 디렉터리를 먼저 보장한다.
        // (예: videos/ 폴더 — 없으면 첫 createWriteStream 이 ENOENT 로 실패해 잡이 멈춘다.)
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(job.savePath), { recursive: true }).catch(() => undefined);
        const pending = job.segments.filter((s) => !s.done);
        await Promise.all(pending.map((seg) => downloadSegment(job, seg)));
        const s = job.state;
        if (s === 'cancelled' || s === 'failed' || s === 'paused')
            return;
        // 각 세그먼트가 요청한 범위만큼 받았는지 검증 — CDN 이 206 을 짧게 끝내면 병합이 뒤 세그먼트를
        // 앞으로 밀어 파일이 조용히 손상된다. 부족하면 실패 처리(잘못된 "완료"보다 안전).
        for (const seg of job.segments) {
            const expected = seg.end - seg.start + 1;
            if (seg.received < expected)
                throw new Error(`세그먼트 ${seg.index} 불완전 (${seg.received}/${expected} bytes)`);
        }
        await mergeSegments(job);
        if (job.state === 'cancelled')
            return;
        job.state = 'done';
        job.speed = 0;
        job.onUpdate(job);
        job.onComplete(job);
    }
    catch (err) {
        const cur = job.state;
        // 일시정지 — 단순 종료, 임시 파일 보존, onComplete 호출 안 함
        if (cur === 'paused') {
            job.speed = 0;
            job.onUpdate(job);
            return;
        }
        if (cur === 'cancelled')
            return;
        job.state = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.speed = 0;
        job.onUpdate(job);
        job.onComplete(job);
        // 영구 실패 시 임시 파일 정리 — 단, 이어받기 잡은 이전 세션 .part 를 보존해 다음 부팅에 재시도한다.
        if (!job.preservePartsOnFail) {
            for (const seg of job.segments) {
                try {
                    await node_fs_1.promises.unlink(seg.tempPath);
                }
                catch { /* ignore */ }
            }
        }
    }
    finally {
        job.running = false;
    }
}
async function startAcceleratedDownload(args) {
    const connections = args.connections ?? DEFAULT_CONNECTIONS;
    const ranges = splitRanges(args.totalBytes, connections);
    const segments = ranges.map((r, i) => ({
        index: i,
        start: r.start,
        end: r.end,
        received: 0,
        done: false,
        stream: null,
        request: null,
        tempPath: `${args.savePath}.part${i}`,
    }));
    const now = Date.now();
    const job = {
        id: args.id,
        url: args.url,
        savePath: args.savePath,
        totalBytes: args.totalBytes,
        receivedBytes: 0,
        segments,
        state: 'active',
        connections: ranges.length,
        speed: 0,
        startedAt: now,
        session: args.session,
        headers: args.headers,
        onUpdate: args.onUpdate,
        onComplete: args.onComplete,
        lastTickAt: now,
        lastTickBytes: 0,
    };
    void runJob(job);
    return job;
}
/**
 * 부팅 시 영속화된 가속 작업을 이어받는다. 각 .part<i> 임시 파일의 현재 크기로
 * 받은 양(received)을 복원하고, 다 받은 세그먼트는 done 처리한 뒤 미완료분만 Range 로 이어받는다.
 */
async function resumeAcceleratedDownload(args) {
    const segments = [];
    let receivedTotal = 0;
    for (const [i, r] of args.ranges.entries()) {
        const tempPath = `${args.savePath}.part${i}`;
        const segSize = r.end - r.start + 1;
        let received = 0;
        try {
            const st = await node_fs_1.promises.stat(tempPath);
            received = Math.min(st.size, segSize);
        }
        catch {
            received = 0;
        }
        receivedTotal += received;
        segments.push({
            index: i,
            start: r.start,
            end: r.end,
            received,
            done: received >= segSize,
            stream: null,
            request: null,
            tempPath,
        });
    }
    const now = Date.now();
    const job = {
        id: args.id,
        url: args.url,
        savePath: args.savePath,
        totalBytes: args.totalBytes,
        receivedBytes: receivedTotal,
        segments,
        state: 'active',
        connections: args.ranges.length,
        speed: 0,
        startedAt: now,
        session: args.session,
        headers: args.headers,
        preservePartsOnFail: true,
        onUpdate: args.onUpdate,
        onComplete: args.onComplete,
        lastTickAt: now,
        lastTickBytes: receivedTotal,
    };
    void runJob(job);
    return job;
}
function pauseJob(job) {
    // 병합(merging) 중에는 일시정지 불가 — 로컬 디스크 병합은 중단 지점이 없고,
    // 중간에 paused 로 바꾸면 resume 이 두 번째 병합을 일으켜 파일이 깨진다.
    if (job.state !== 'active')
        return false;
    job.state = 'paused';
    for (const seg of job.segments) {
        if (seg.done)
            continue;
        try {
            seg.request?.abort();
        }
        catch { /* ignore */ }
        // stream 은 abort 의 reject path 가 end 처리하지만, 안전망
        try {
            seg.stream?.end();
        }
        catch { /* ignore */ }
    }
    job.speed = 0;
    job.lastTickAt = Date.now();
    job.lastTickBytes = job.receivedBytes;
    job.onUpdate(job);
    return true;
}
function resumeJob(job) {
    if (job.state !== 'paused')
        return false;
    // 모든 segment 가 이미 done 이면 merge 만 남았을 수 있음 → runJob 이 알아서 처리
    job.state = 'active';
    job.lastTickAt = Date.now();
    job.lastTickBytes = job.receivedBytes;
    job.onUpdate(job);
    void runJob(job);
    return true;
}
function cancelJob(job) {
    if (job.state === 'done' || job.state === 'cancelled')
        return;
    job.state = 'cancelled';
    for (const seg of job.segments) {
        try {
            seg.request?.abort();
        }
        catch { /* ignore */ }
        try {
            seg.stream?.end();
        }
        catch { /* ignore */ }
    }
    // 임시 파일 정리 (비동기, 실패해도 무시)
    void (async () => {
        for (const seg of job.segments) {
            try {
                await node_fs_1.promises.unlink(seg.tempPath);
            }
            catch { /* ignore */ }
        }
    })();
    job.onUpdate(job);
}
function metaFromJob(job, baseMeta) {
    let dtoState;
    switch (job.state) {
        case 'metadata':
            dtoState = 'metadata';
            break;
        case 'merging':
        case 'active':
            dtoState = 'active';
            break;
        case 'paused':
            dtoState = 'paused';
            break;
        case 'done':
            dtoState = 'done';
            break;
        case 'cancelled':
            dtoState = 'cancelled';
            break;
        case 'failed':
        default:
            dtoState = 'failed';
            break;
    }
    return {
        ...baseMeta,
        totalBytes: job.totalBytes,
        receivedBytes: job.receivedBytes,
        state: dtoState,
        speed: job.speed,
        error: job.error,
        accelerator: { connections: job.connections },
    };
}
