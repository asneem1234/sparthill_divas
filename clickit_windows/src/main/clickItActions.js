// The five Click It actions shown as gemstones. Port of ClickItAction in ClickItOrbMenu.swift.
// The Mac menu only verifies the menu itself for now: selecting an action shows a
// placeholder and nothing is captured or sent to the AI.

const CLICK_IT_ACTIONS = [
  {
    id: 'snap',
    label: 'Snap',
    tooltip: 'Capture your screen and get a summary and explanation',
    iconName: 'camera-viewfinder',
    gemstoneColor: { red: 0.25, green: 0.52, blue: 0.96 },
    isAvailable: true,
  },
  {
    id: 'askExplain',
    label: 'Ask / Explain',
    tooltip: 'Ask a question about your screen or selected text',
    iconName: 'question-bubble',
    gemstoneColor: { red: 0.36, green: 0.76, blue: 0.47 },
    isAvailable: true,
  },
  {
    id: 'translate',
    label: 'Translate',
    tooltip: 'Translate selected text or screen content',
    iconName: 'character-bubble',
    gemstoneColor: { red: 0.96, green: 0.62, blue: 0.22 },
    isAvailable: true,
  },
  {
    id: 'speech',
    label: 'Voice chat',
    tooltip: 'Talk with Click It, hands-free, voice to voice',
    iconName: 'waveform',
    gemstoneColor: { red: 0.64, green: 0.38, blue: 0.93 },
    // Doesn't look at any window: opens the voice chat window straight away.
    isAvailable: true,
  },
  {
    id: 'privacyGuard',
    label: 'Privacy Guard',
    tooltip: 'Check content for sensitive information before sharing',
    iconName: 'lock-shield',
    gemstoneColor: { red: 0.91, green: 0.31, blue: 0.38 },
    isAvailable: true,
  },
];

module.exports = { CLICK_IT_ACTIONS };
