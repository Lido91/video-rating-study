// Settings for the GT Mesh study (mesh/). It uses the same app as the main study (../app.js);
// see the README for what each setting does.
window.STUDY_CONFIG = {
  // Change this when you start a new round, so returning raters start fresh.
  studyId: "mesh-fidelity-v1",

  title: "Sign Language 3D Mesh Study",

  // The web app URL of this study's own Google Sheet (a separate Sheet from the main study;
  // see README, "GT Mesh study"). Leave empty to run in demo mode: answers stay in the browser.
  scriptUrl: "",

  instructions: `Before the videos, you will answer a few short questions about your hearing status and your experience with ASL. They help us interpret your ratings; we do not ask for your name or any contact details.

Each video shows one English sentence in sign language, in two panels side by side. On the left is a real person signing (GT Video). On the right is a 3D avatar (GT Mesh) that was reconstructed from that real video and should copy the person's motion: hand shapes, arm and hand movements, and body posture. The sentence is shown above each video.

Watch the whole video, then rate how well the GT Mesh reflects the signing in the real video, from 1 (very poorly) to 5 (very well). There are no right or wrong answers — we are interested in your own judgement. You can replay a video before answering.

Please use a computer rather than a phone. There are 50 short videos and the study takes about 15 minutes. Your progress is saved, so you can close the page and come back later with the same participant ID.`,

  consent: "I agree to take part in this study and understand my answers will be recorded anonymously.",

  askRaterId: true,

  // Same background questions as the main study, so the two can be compared.
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
        { value: "1 None", label: "1 – No knowledge of ASL" },
        { value: "2 Beginner", label: "2 – Beginner: I know some signs or basic phrases" },
        { value: "3 Intermediate", label: "3 – Intermediate: I can hold simple conversations" },
        { value: "4 Advanced", label: "4 – Advanced: I can follow most conversations comfortably" },
        { value: "5 Native/fluent", label: "5 – Native or fluent: ASL is my first language, or I use it fluently every day" },
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

  // One rating per video. Keys 1–5 also answer it.
  questions: [
    {
      id: "mesh_fidelity",
      text: "How well does the GT Mesh reflect the signing in the real video (GT Video)?",
      options: [
        { value: "1", label: "Very poorly" },
        { value: "2", label: "Poorly" },
        { value: "3", label: "Moderately" },
        { value: "4", label: "Well" },
        { value: "5", label: "Very well" },
      ],
    },
  ],

  randomizeOrder: true,
  requireFullWatch: true,
  maxPlays: 0,

  completionCode: "",
};
