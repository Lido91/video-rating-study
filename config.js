// Study settings. Edit this file, then commit and push to update the live site.
window.STUDY_CONFIG = {
  // Change this when you start a new round, so returning raters start fresh.
  studyId: "video-study-v1",

  title: "Video Rating Study",

  // Paste the Google Apps Script web app URL here (see README, step 2).
  // Leave empty to run in demo mode: ratings stay in the browser and can be downloaded as CSV.
  scriptUrl: "",

  // Shown on the welcome screen. Plain text; blank lines start a new paragraph.
  instructions: `You will watch a series of short videos. After each one, rate it using the scale below.

There are no right or wrong answers — we are interested in your own impression. Please watch each video all the way through before rating.

The study takes about 10 minutes. Your progress is saved, so you can close the page and come back later with the same participant ID.`,

  // Consent statement the rater must tick before starting. Set to "" to skip.
  consent: "I agree to take part in this study and understand my ratings will be recorded anonymously.",

  // Ask for a participant ID. It is pre-filled from ?id=... or ?PROLIFIC_PID=... in the link.
  // If false, a random anonymous ID is generated.
  askRaterId: true,

  randomizeOrder: true,     // each rater gets their own shuffled order (stable across reloads)
  requireFullWatch: true,   // rating unlocks only after the video plays to the end
  maxPlays: 2,              // how many times a rater may play each video (1 = no replay)

  // One or more questions per video. Each label is one point; values run 1..labels.length.
  questions: [
    {
      id: "quality",
      text: "How would you rate the overall quality of this video?",
      labels: ["Bad", "Poor", "Fair", "Good", "Excellent"],
    },
  ],

  // Shown on the final screen (e.g. a Prolific / MTurk completion code). Leave "" to hide.
  completionCode: "",
};
