// 새 탭 픽셀 친구 — 로고 마스코트(파랑 깃털 새)를 16×16 픽셀 아트로 그려 검색창 위 무대에서 놀게 한다.
//
// 가벼움 원칙:
//  - 이미지 파일 0개. 스프라이트는 이 파일 안의 문자열 격자, 캔버스 1개에 정수 배율로 그린다.
//  - 10fps 타이머 하나. 탭이 안 보이면(visibilitychange) 완전히 멈춘다 → 휴식 CPU 0.
//  - prefers-reduced-motion 이면 걷기·파티클 없이 정지 포즈만(클릭 반응은 표정만 바뀜).
//  - 설정 widgets.buddyEnabled=false 면 index.html 이 이 스크립트를 아예 불러오지 않는다.
//
// 행동: 깜빡임 · 두리번 · 총총 걷기 · 손(날개) 흔들기 · 클릭하면 점프+하트 ·
//       밤(23~6시)엔 잠(Zzz, 클릭하면 잠깐 깸) · 비 오면 우산 · 눈 오면 눈송이 · 마우스를 따라 봄.
;(function () {
  'use strict'

  const stage = document.getElementById('buddy-stage')
  const canvas = document.getElementById('buddy-canvas')
  const bubble = document.getElementById('buddy-bubble')
  if (!stage || !canvas || !canvas.getContext) return
  const ctx = canvas.getContext('2d')

  // ── 무대 규격 (단위 = 픽셀 아트 1칸) ──
  const S = 3                 // 화면 배율
  const W = 120, H = 28       // 무대 칸 수
  canvas.width = W * S
  canvas.height = H * S
  const GROUND = H - 1        // 발이 닿는 줄

  const COLORS = {
    K: '#1f3f7a', // 외곽선
    B: '#7fb2f5', // 몸
    L: '#c7ddff', // 배·광택
    W: '#ffffff', // 눈 하이라이트
    E: '#13213f', // 눈동자
    O: '#f7a23e', // 부리
    D: '#e0683f', // 입 안
    P: '#ffadc0', // 볼
    F: '#f39a2e', // 발
    R: '#ff6b6b', // 우산
    r: '#ffa4a4', // 우산 광택
    H: '#ff5a7a', // 하트
    Z: '#8a9bbf', // Zzz
    A: '#8fbcff', // 빗방울
    S: '#ffffff', // 눈송이
  }

  // 정면 몸통(눈·발·날개는 상태에 따라 따로 그린다). 좌우 대칭(열 c ↔ 15-c).
  const BODY = [
    '......K..K......',
    '.....KBKKBK.....',
    '....KBBBBBBK....',
    '...KBLLBBBBBK...',
    '..KBLBBBBBBBBK..',
    '..KBBBBBBBBBBK..',
    '.KBBBBBBBBBBBBK.',
    '.KBPBBBOOBBBPBK.',
    '.KBBBBBDDBBBBBK.',
    '.KBBBLLLLLLBBBK.',
    '.KBBLLLLLLLLBBK.',
    '..KBLLLLLLLLBK..',
    '..KBBLLLLLLBBK..',
    '...KBBBBBBBBK...',
    '....KKKKKKKK....',
  ]
  // 날개 (왼쪽 기준 [x, y, 색]) — 오른쪽은 x → 15-x 로 거울.
  const WING_DOWN = [[0, 9, 'K'], [0, 10, 'K'], [1, 9, 'B'], [1, 10, 'B'], [1, 11, 'K'], [0, 8, 'K']]
  const WING_UP = [[1, 4, 'K'], [0, 5, 'K'], [1, 5, 'B'], [0, 6, 'K'], [1, 6, 'B'], [0, 7, 'K'], [1, 7, 'B']]
  const UMBRELLA = [
    '....RRRR....',
    '..RrrRRRRR..',
    '.RrRRRRRRRR.',
    'RRRRRRRRRRRR',
    'R..R..R..R.R',
    '.....KK.....',
    '.....KK.....',
    '.....KK.....',
  ]
  const HEART = ['.H.H.', 'HHHHH', '.HHH.', '..H..']
  const ZED = ['ZZZZ', '..Z.', '.Z..', 'ZZZZ']

  // ── 상태 ──
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const st = {
    x: Math.floor((W - 16) / 2), // 새 왼쪽 위 x
    jump: 0, jumpT: -1,          // 점프 진행(틱)
    mode: 'idle',                // idle | walk | wave | look
    modeT: 0, target: 0, dir: 1,
    look: 0,                     // 눈동자 방향 -1/0/1
    blinkT: 30, happyT: 0,
    wakeT: 0,                    // 밤에 깨어 있는 남은 틱
    tick: 0,
    weather: 'clear',            // clear | rain | snow
    mouseX: null,
  }
  const particles = [] // {kind, x, y, vx, vy, life}

  function isNight() {
    const h = new Date().getHours()
    return h >= 23 || h < 6
  }
  function sleeping() { return isNight() && st.wakeT <= 0 }
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

  // ── 그리기 ──
  function px(x, y, c) {
    if (!c || c === '.') return
    ctx.fillStyle = COLORS[c]
    ctx.fillRect(x * S, y * S, S, S)
  }
  function sprite(rows, ox, oy) {
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++) px(ox + x, oy + y, rows[y][x])
  }

  function drawBird(ox, oy) {
    sprite(BODY, ox, oy)

    // 날개
    const flap = st.jumpT >= 0 || (st.mode === 'wave' && st.tick % 4 < 2)
    const leftUp = st.jumpT >= 0
    const rightUp = flap
    for (const [x, y, c] of leftUp ? WING_UP : WING_DOWN) px(ox + x, oy + y, c)
    for (const [x, y, c] of rightUp ? WING_UP : WING_DOWN) px(ox + 15 - x, oy + y, c)

    // 눈 (왼 4-5, 오른 10-11 기준, 시선만큼 1칸 이동)
    const asleep = sleeping()
    const blink = st.blinkT <= 1
    for (const base of [4, 10]) {
      const ex = base + st.look
      if (asleep || blink) {
        px(ox + ex, oy + 6, 'K'); px(ox + ex + 1, oy + 6, 'K')
      } else if (st.happyT > 0) {
        px(ox + ex - 1, oy + 6, 'K'); px(ox + ex, oy + 5, 'K')
        px(ox + ex + 1, oy + 5, 'K'); px(ox + ex + 2, oy + 6, 'K')
      } else {
        px(ox + ex, oy + 5, 'W'); px(ox + ex + 1, oy + 5, 'E')
        px(ox + ex, oy + 6, 'E'); px(ox + ex + 1, oy + 6, 'E')
      }
    }

    // 발 (걸을 때 번갈아 든다, 점프 중엔 둘 다)
    const step = st.mode === 'walk' ? (st.tick % 4 < 2 ? 0 : 1) : -1
    if (st.jumpT < 0) {
      if (step !== 0) px(ox + 5, oy + 15, 'F')
      if (step !== 1) px(ox + 10, oy + 15, 'F')
      px(ox + 6, oy + 15, 'F'); px(ox + 9, oy + 15, 'F')
    } else {
      px(ox + 6, oy + 15, 'F'); px(ox + 9, oy + 15, 'F')
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const asleep = sleeping()
    const bob = asleep ? (st.tick % 20 < 10 ? 1 : 0) : (st.mode === 'walk' && st.tick % 2 ? -1 : 0)
    const oy = GROUND - 15 - st.jump + bob
    if (st.weather === 'rain') sprite(UMBRELLA, st.x + 2, oy - 7)
    drawBird(st.x, oy)
    for (const p of particles) {
      if (p.kind === 'heart') sprite(HEART, Math.round(p.x), Math.round(p.y))
      else if (p.kind === 'zed') sprite(ZED, Math.round(p.x), Math.round(p.y))
      else if (p.kind === 'rain') { px(Math.round(p.x), Math.round(p.y), 'A'); px(Math.round(p.x), Math.round(p.y) + 1, 'A') }
      else if (p.kind === 'snow') px(Math.round(p.x), Math.round(p.y), 'S')
    }
    // 말풍선은 새 머리 위를 따라다닌다
    if (bubble) bubble.style.left = ((st.x + 8) * S) + 'px'
  }

  // ── 행동 ──
  function say(text, ms) {
    if (!bubble) return
    bubble.textContent = text
    bubble.classList.add('show')
    clearTimeout(say.t)
    say.t = setTimeout(() => bubble.classList.remove('show'), ms || 2200)
  }

  function chooseAction() {
    const r = Math.random()
    if (r < 0.45) {
      st.mode = 'walk'
      st.target = rand(4, W - 20)
      st.dir = st.target > st.x ? 1 : -1
    } else if (r < 0.7) {
      st.mode = 'look'; st.modeT = rand(10, 18)
    } else if (r < 0.85) {
      st.mode = 'wave'; st.modeT = 14
    } else {
      st.mode = 'idle'; st.modeT = rand(8, 18)
    }
  }

  function update() {
    st.tick++
    // 깜빡임
    if (--st.blinkT < 0) st.blinkT = rand(25, 55)
    if (st.happyT > 0) st.happyT--
    if (st.wakeT > 0) st.wakeT--

    // 점프 (포물선 8틱)
    if (st.jumpT >= 0) {
      st.jumpT++
      const t = st.jumpT / 8
      st.jump = Math.max(0, Math.round(10 * t * (1 - t) * 1.6))
      if (st.jumpT >= 8) { st.jumpT = -1; st.jump = 0 }
    }

    if (sleeping()) {
      st.mode = 'idle'; st.look = 0
      if (st.tick % 18 === 0) particles.push({ kind: 'zed', x: st.x + 13, y: GROUND - 15, vx: 0.2, vy: -0.45, life: 22 })
    } else if (st.mode === 'walk') {
      st.look = st.dir
      if (st.tick % 2 === 0) st.x += st.dir
      if (st.x === st.target || st.x <= 1 || st.x >= W - 17) { st.mode = 'idle'; st.modeT = rand(10, 25); st.look = 0 }
    } else if (st.mode === 'look') {
      if (st.tick % 6 === 0) st.look = [-1, 0, 1][rand(0, 2)]
      if (--st.modeT <= 0) { st.mode = 'idle'; st.modeT = rand(10, 25); st.look = 0 }
    } else if (st.mode === 'wave') {
      if (--st.modeT <= 0) { st.mode = 'idle'; st.modeT = rand(15, 30) }
    } else {
      // idle: 마우스가 무대 위에 있으면 그쪽을 본다
      if (st.mouseX != null) {
        const cx = (st.x + 8) * S
        st.look = st.mouseX < cx - 20 ? -1 : st.mouseX > cx + 20 ? 1 : 0
      }
      if (--st.modeT <= 0) chooseAction()
    }

    // 날씨 파티클
    if (st.weather === 'rain' && Math.random() < 0.6)
      particles.push({ kind: 'rain', x: rand(0, W - 1), y: -2, vx: -0.2, vy: 1.6, life: 30 })
    if (st.weather === 'snow' && Math.random() < 0.3)
      particles.push({ kind: 'snow', x: rand(0, W - 1), y: -1, vx: (Math.random() - 0.5) * 0.3, vy: 0.35, life: 90 })

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      p.x += p.vx; p.y += p.vy; p.life--
      if (p.life <= 0 || p.y > H) particles.splice(i, 1)
    }
  }

  // ── 상호작용 ──
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect()
    const ux = (e.clientX - rect.left) / (rect.width / W)
    const onBird = ux >= st.x - 1 && ux <= st.x + 17
    if (!onBird) {
      // 빈 곳을 누르면 거기로 걸어간다
      if (!sleeping() && !reduced) {
        st.mode = 'walk'
        st.target = Math.max(2, Math.min(W - 18, Math.round(ux - 8)))
        st.dir = st.target >= st.x ? 1 : -1
      }
      return
    }
    if (sleeping()) {
      st.wakeT = 60 // 약 6초 깨어 있다 다시 잔다
      say('으음… 아직 밤이에요 😴', 1800)
    } else {
      const lines = ['안녕하세요!', '오늘도 가볍게 🪶', '찾으시는 게 있나요?', '헤헤', '같이 둘러봐요!']
      say(lines[rand(0, lines.length - 1)], 1600)
    }
    st.happyT = 12
    if (!reduced) {
      st.jumpT = 0
      particles.push({ kind: 'heart', x: st.x + 5, y: GROUND - 23, vx: 0, vy: -0.4, life: 16 })
    }
    if (reduced) draw()
  })
  stage.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    st.mouseX = e.clientX - rect.left
  })
  stage.addEventListener('mouseleave', () => { st.mouseX = null })

  // ── 루프 (보이는 동안만) ──
  let timer = null
  function loop() {
    update()
    draw()
    timer = setTimeout(loop, 100)
  }
  function start() { if (!timer && !reduced) loop() }
  function stop() { clearTimeout(timer); timer = null }
  document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start() })

  // ── 날씨 연동 (날씨 위젯이 켜져 있을 때만 — 꺼져 있으면 네트워크 요청을 만들지 않는다) ──
  function weatherKind(code) {
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain'
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
    return 'clear'
  }
  window.bbBuddy = {
    // 날씨 카드가 이미 받은 결과를 넘겨준다(중복 요청 없음)
    get tick() { return st.tick }, // 검증용(읽기 전용): 루프가 도는지 확인
    setWeather(w) { if (w && typeof w.code === 'number') { st.weather = weatherKind(w.code); draw() } },
  }

  // 날씨 카드가 이 스크립트보다 먼저 받아 둔 결과가 있으면 반영
  if (window.__bbLastWeather) window.bbBuddy.setWeather(window.__bbLastWeather)

  // 첫 인사
  draw()
  start()
  if (!sleeping()) {
    const h = new Date().getHours()
    const hello = h < 11 ? '좋은 아침이에요!' : h < 17 ? '안녕하세요!' : '좋은 저녁이에요!'
    setTimeout(() => { st.mode = 'wave'; st.modeT = 14; say(hello, 2200); if (reduced) draw() }, 400)
  }
})()
