export const missionTemplates = {
  companySprint: { summary: "A focused team sprint with a clear delivery rhythm.", rooms: ["missionCore", "workshop", "reviewDeck", "surgeHall"], moves: ["Set the sprint outcome", "Ship the first working slice", "Review and publish Proof"] },
  classroomProject: { summary: "A structured learning project with research, making, and review.", rooms: ["missionCore", "observatory", "workshop", "reviewDeck"], moves: ["Frame the research question", "Build the shared artifact", "Peer review the evidence"] },
  contentProduction: { summary: "A collaborative production room for an attributable piece of work.", rooms: ["missionCore", "observatory", "workshop", "reviewDeck"], moves: ["Choose the audience promise", "Create the production draft", "Approve the final cut"] },
  openChallenge: { summary: "A public-interest challenge designed for bounded contributions.", rooms: ["missionCore", "signalTower", "observatory", "workshop", "reviewDeck"], moves: ["State the challenge and constraints", "Answer the first Call", "Verify the shared Proof"] },
} as const;

export type MissionTemplateKey = keyof typeof missionTemplates;
export function isMissionTemplateKey(value: string): value is MissionTemplateKey { return value in missionTemplates; }
