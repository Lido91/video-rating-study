// Settings for the two-part evaluation study (eval/). It has its own page, styles and app
// (index.html, style.css, app.js here); answers use the same row format as the other studies,
// so the same Google Sheet script (apps-script/Code.gs) works for it. See README, "Evaluation study".
window.STUDY_CONFIG = {
  // Change this when you start a new round, so returning raters start fresh.
  studyId: "avatar-eval-v1",

  title: "ASL Avatar Evaluation",

  // The web app URL of this study's own Google Sheet ("Avatar eval study results"). Leave empty
  // to run in demo mode: answers stay in the browser (and are sent once a URL is filled in).
  scriptUrl: "https://script.google.com/macros/s/AKfycbzzrTy45y1uPXbmLtAKnLC5G6ls0zVctaMtzFoqt6KStAUX0GCdCCz8lYIbT_evuEBAVw/exec",

  intro: `In this study you will watch short clips of American Sign Language. Each clip shows a real person signing an English sentence next to one or two 3D avatars, and you tell us how well the avatars sign.

There are no right or wrong answers; we are interested in your own judgement. The avatars have no facial expression or mouth movement, so please judge only what the hands, arms and body convey.`,

  notes: [
    "Please use a computer rather than a phone.",
    "You can replay each clip as often as you like before answering.",
    "Your progress is saved: close the page and come back later with the same participant ID.",
    "We do not ask for your name or any contact details.",
  ],

  consent: "I agree to take part in this study and understand my answers will be recorded anonymously.",

  // Background questions, asked once before Part 1. Same as the other studies, so groups can be compared.
  survey: [
    {
      id: "hearing_status",
      text: "Which best describes your hearing status?",
      options: [
        { value: "Deaf", label: "Deaf" },
        { value: "Hard of hearing", label: "Hard of hearing" },
        { value: "Hearing", label: "Hearing" },
        { value: "Prefer not to say", label: "Prefer not to say" },
      ],
    },
    {
      id: "asl_level",
      text: "How would you rate your ASL proficiency?",
      options: [
        { value: "1 None", label: "No knowledge of ASL" },
        { value: "2 Beginner", label: "Beginner: I know some signs or basic phrases" },
        { value: "3 Intermediate", label: "Intermediate: I can hold simple conversations" },
        { value: "4 Advanced", label: "Advanced: I can follow most conversations comfortably" },
        { value: "5 Native/fluent", label: "Native or fluent: ASL is my first language, or I use it fluently every day" },
      ],
    },
    {
      id: "asl_age_learned",
      text: "At what age did you start learning ASL?",
      options: [
        { value: "1 From birth", label: "From birth (e.g., I grew up with ASL at home)" },
        { value: "2 Age 1-5", label: "Between ages 1 and 5" },
        { value: "3 Age 6-12", label: "Between ages 6 and 12" },
        { value: "4 Age 13-17", label: "Between ages 13 and 17" },
        { value: "5 Age 18+", label: "Age 18 or older" },
        { value: "6 Never", label: "I have not learned ASL" },
      ],
    },
    {
      id: "asl_years",
      text: "How many years have you been using ASL?",
      options: [
        { value: "0 None", label: "I don't use ASL" },
        { value: "1 Under 1 year", label: "Less than 1 year" },
        { value: "2 1-3 years", label: "1–3 years" },
        { value: "3 4-10 years", label: "4–10 years" },
        { value: "4 Over 10 years", label: "More than 10 years" },
      ],
    },
    {
      id: "asl_frequency",
      text: "How often do you use ASL?",
      options: [
        { value: "1 Daily", label: "Daily" },
        { value: "2 Weekly", label: "Weekly" },
        { value: "3 Monthly", label: "Monthly" },
        { value: "4 Rarely", label: "Rarely" },
        { value: "5 Never", label: "Never" },
      ],
    },
  ],

  // The two parts, in the order raters see them. Clips are shuffled within each part.
  parts: [
    {
      id: "compare",
      name: "Compare two avatars",
      summary: "Pick the avatar that signs the sentence better.",
      // Labels drawn above the video's panels, left to right.
      panels: ["GT Video", "Avatar A", "Avatar B"],
      instructions: `Each clip shows the real signer (GT Video) on the left and two avatars, A and B. The avatars were created by computer from the English sentence alone; they never saw the video, so they will not copy the signer's exact timing or style.

Watch the clip, then choose the avatar whose signing conveys the meaning of the sentence better, judging against the real signer. If they seem close, pick the one you think is slightly better. Which avatar is A and which is B changes from clip to clip.`,
      question: {
        id: "pair_preference",
        text: "Which avatar conveys the meaning of the signing in the real video (GT Video) better?",
        // value: what is saved (the Sheet's Mapping tab says which system each A/B is). keys: keyboard shortcuts.
        options: [
          { value: "A", label: "Avatar A", keys: ["a", "1"] },
          { value: "B", label: "Avatar B", keys: ["b", "2"] },
        ],
      },
    },
    {
      id: "recon",
      name: "Rate the GT Mesh",
      summary: "Rate how well the GT Mesh reflects the real video (GT Video).",
      panels: ["GT Video", "GT Mesh"],
      instructions: `Each clip shows one sentence in two panels side by side. On the left is a real person signing (GT Video). On the right is a 3D avatar (GT Mesh) that was reconstructed from that real video and should copy the person's motion: hand shapes, arm and hand movements, and body posture.

Watch the clip, then rate how well the GT Mesh reflects the signing in the real video, from 1 (very poorly) to 5 (very well).`,
      question: {
        // Same id, wording and scale as the GT Mesh study (mesh/), so the answers can be compared clip by clip.
        id: "mesh_fidelity",
        text: "How well does the GT Mesh reflect the signing in the real video (GT Video)?",
        scale: true,
        options: [
          { value: "1", label: "Very poorly" },
          { value: "2", label: "Poorly" },
          { value: "3", label: "Moderately" },
          { value: "4", label: "Well" },
          { value: "5", label: "Very well" },
        ],
      },
    },
  ],

  // Raters can answer only after the clip has played to the end once.
  requireFullWatch: true,

  completionCode: "",
};
