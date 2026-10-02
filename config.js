// Study settings. Edit this file, then commit and push to update the live site.
window.STUDY_CONFIG = {
  // Change this when you start a new round, so returning raters start fresh.
  studyId: "video-study-v1",

  title: "Video Comparison Study",

  // Paste the Google Apps Script web app URL here (see README, step 2).
  // Leave empty to run in demo mode: answers stay in the browser and can be downloaded as CSV.
  scriptUrl: "",

  // Shown on the welcome screen. Plain text; blank lines start a new paragraph.
  instructions: `In each round you will see several versions of the same video side by side, labeled A, B, C, and so on. They play at the same time.

Watch them all the way through, then choose the one that looks the most natural. There are no right or wrong answers — we are interested in your own impression. You can replay a round before answering.

Please use a computer with a large screen rather than a phone. The study takes about 10 minutes. Your progress is saved, so you can close the page and come back later with the same participant ID.`,

  // Consent statement the rater must tick before starting. Set to "" to skip.
  consent: "I agree to take part in this study and understand my answers will be recorded anonymously.",

  // Ask for a participant ID. It is pre-filled from ?id=... or ?PROLIFIC_PID=... in the link.
  // If false, a random anonymous ID is generated.
  askRaterId: true,

  // Asked after each round; the answer is one of the videos shown. Add more to ask several things.
  questions: [
    { id: "natural", text: "Which video looks the most natural?" },
  ],

  randomizeOrder: true,      // each rater gets their own order of rounds (stable across reloads)
  randomizePositions: true,  // shuffle which method appears as A, B, C... in every round
  requireFullWatch: true,    // answering unlocks only after every video has played to the end
  maxPlays: 3,               // how many times a rater may play each round (1 = no replay)

  // Videos play muted. Set true to hear the sound of the left-most video only
  // (use this when every version shares the same soundtrack).
  playAudio: false,

  // Shown on the final screen (e.g. a Prolific / MTurk completion code). Leave "" to hide.
  completionCode: "",
};
