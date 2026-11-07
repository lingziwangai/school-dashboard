// 小狼头像：纯 SVG，按学校机器人上的狼人偶形象画的
// （灰毛、白口鼻、戴白帽、红围巾）。四种表情：idle / thinking / happy / alert。

const EXPRESSIONS = ["idle", "thinking", "happy", "alert"];

const SVG = `
<svg viewBox="0 0 200 200" class="wolf" xmlns="http://www.w3.org/2000/svg" role="img">
  <defs>
    <radialGradient id="fur" cx="42%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#aab4c2"/>
      <stop offset="60%" stop-color="#8d97a8"/>
      <stop offset="100%" stop-color="#6d7789"/>
    </radialGradient>
    <radialGradient id="muzzle" cx="50%" cy="35%" r="70%">
      <stop offset="0%" stop-color="#f2ede4"/>
      <stop offset="100%" stop-color="#d8d0c2"/>
    </radialGradient>
  </defs>

  <!-- 围巾（脖子后面） -->
  <path d="M46 150 Q100 132 154 150 L160 182 Q100 200 40 182 Z" fill="#d1705a"/>
  <path d="M46 150 Q100 132 154 150 L152 162 Q100 146 48 162 Z" fill="#b85a48"/>

  <!-- 耳朵 -->
  <g class="ears">
    <path d="M46 62 L38 16 L82 42 Z" fill="url(#fur)"/>
    <path d="M48 58 L43 27 L74 45 Z" fill="#c9a3a0"/>
    <path d="M154 62 L162 16 L118 42 Z" fill="url(#fur)"/>
    <path d="M152 58 L157 27 L126 45 Z" fill="#c9a3a0"/>
  </g>

  <!-- 头 -->
  <path d="M100 26
           C142 26 164 58 164 92
           C164 128 138 152 100 152
           C62 152 36 128 36 92
           C36 58 58 26 100 26 Z" fill="url(#fur)"/>

  <!-- 脸颊浅色毛 -->
  <path d="M100 26 C142 26 164 58 164 92 C164 112 154 128 140 138
           C150 118 146 84 100 78 C54 84 50 118 60 138
           C46 128 36 112 36 92 C36 58 58 26 100 26 Z" fill="#b9c2ce" opacity="0.45"/>

  <!-- 口鼻 -->
  <ellipse cx="100" cy="116" rx="42" ry="33" fill="url(#muzzle)"/>

  <!-- 帽子 -->
  <g class="cap">
    <path d="M40 52 C40 20 66 4 100 4 C134 4 160 20 160 52 Z" fill="#ece6db"/>
    <path d="M40 52 C40 20 66 4 100 4 C134 4 160 20 160 52 Z" fill="none" stroke="#cfc7b9" stroke-width="1.5"/>
    <path d="M34 50 L166 50 L166 62 L34 62 Z" fill="#d9d1c3"/>
    <path d="M100 14 L100 50" stroke="#d9d1c3" stroke-width="1.2" opacity="0.6"/>
    <text x="100" y="42" text-anchor="middle" font-size="19" font-weight="700"
          fill="#c0705c" font-family="Georgia, serif" letter-spacing="2">SNA</text>
  </g>

  <!-- 眉毛 -->
  <g class="brows">
    <path class="brow brow-l" d="M62 74 Q74 66 86 72" stroke="#5c6675" stroke-width="4.5"
          fill="none" stroke-linecap="round"/>
    <path class="brow brow-r" d="M114 72 Q126 66 138 74" stroke="#5c6675" stroke-width="4.5"
          fill="none" stroke-linecap="round"/>
  </g>

  <!-- 眼睛（睁眼） -->
  <g class="eyes-open">
    <ellipse cx="74" cy="92" rx="13" ry="12" fill="#f7f3ec"/>
    <ellipse cx="126" cy="92" rx="13" ry="12" fill="#f7f3ec"/>
    <circle class="pupil" cx="75" cy="93" r="6" fill="#2f2a2c"/>
    <circle class="pupil" cx="125" cy="93" r="6" fill="#2f2a2c"/>
    <circle class="glint" cx="77.5" cy="90" r="1.9" fill="#fff" opacity="0.9"/>
    <circle class="glint" cx="127.5" cy="90" r="1.9" fill="#fff" opacity="0.9"/>
  </g>

  <!-- 眯眼（思考） -->
  <g class="eyes-half">
    <path d="M62 93 Q74 85 86 93" stroke="#39414d" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M114 93 Q126 85 138 93" stroke="#39414d" stroke-width="4" fill="none" stroke-linecap="round"/>
  </g>

  <!-- 开心眼（弯月） -->
  <g class="eyes-happy">
    <path d="M62 94 Q74 80 86 94" stroke="#39414d" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M114 94 Q126 80 138 94" stroke="#39414d" stroke-width="5" fill="none" stroke-linecap="round"/>
  </g>

  <!-- 鼻子 -->
  <path d="M100 100 C106 100 112 105 112 110 C112 117 106 121 100 121
           C94 121 88 117 88 110 C88 105 94 100 100 100 Z" fill="#3a3038"/>

  <!-- 嘴 -->
  <g class="mouths">
    <path class="mouth mouth-idle" d="M82 128 Q100 138 118 128" stroke="#4a3f42" stroke-width="4"
          fill="none" stroke-linecap="round"/>
    <path class="mouth mouth-think" d="M88 130 L112 130" stroke="#4a3f42" stroke-width="4"
          fill="none" stroke-linecap="round"/>
    <path class="mouth mouth-happy" d="M78 124 Q100 146 122 124 Q100 132 78 124 Z" fill="#5c3a3a"/>
    <ellipse class="mouth mouth-alert" cx="100" cy="132" rx="11" ry="13" fill="#5c3a3a"/>
  </g>

  <!-- 腮红 -->
  <g class="blush">
    <ellipse cx="56" cy="112" rx="11" ry="7" fill="#d1705a" opacity="0.28"/>
    <ellipse cx="144" cy="112" rx="11" ry="7" fill="#d1705a" opacity="0.28"/>
  </g>

  <!-- 气泡 -->
  <g class="bubbles">
    <g class="bubble bubble-think" transform="translate(158,26)">
      <circle class="bubble-bg" r="15" fill="#121826" stroke="#7fb2e5" stroke-width="2"/>
      <circle class="bubble-dot" cx="-5" cy="0" r="1.8" fill="#7fb2e5"/>
      <circle class="bubble-dot" cx="0" cy="0" r="1.8" fill="#7fb2e5"/>
      <circle class="bubble-dot" cx="5" cy="0" r="1.8" fill="#7fb2e5"/>
    </g>
    <g class="bubble bubble-alert" transform="translate(160,28)">
      <circle class="bubble-bg" r="15" fill="#121826" stroke="#d68a80" stroke-width="2"/>
      <rect class="bubble-bar" x="-2" y="-8" width="4" height="10" rx="2" fill="#d68a80"/>
      <circle class="bubble-dot" cx="0" cy="6" r="2.2" fill="#d68a80"/>
    </g>
  </g>
</svg>`;

export function createWolf(container) {
  container.innerHTML = SVG;
  const root = container.querySelector("svg");

  function setExpression(name) {
    if (!EXPRESSIONS.includes(name)) name = "idle";
    root.dataset.expression = name;
    container.dataset.expression = name;
  }

  setExpression("idle");
  return { setExpression, element: root };
}
