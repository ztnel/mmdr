import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "dark",
  deterministicIds: true,
  deterministicIDSeed: "diagram-review",
  themeVariables: {
    background: "#0d1117",
    primaryColor: "#161b22",
    primaryTextColor: "#e6edf3",
    primaryBorderColor: "#8b949e",
    lineColor: "#8b949e",
    secondaryColor: "#21262d",
    tertiaryColor: "#161b22",
  },
});

export default mermaid;
