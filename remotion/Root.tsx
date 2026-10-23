import { Composition } from "remotion";
import { calcEpisode, DailyPortrait } from "./Portrait/Episode";

// One composition: a vertical episode. props.ep points to public/ep/<run> (written by src/render/remotion.mjs).
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DailyPortrait"
      component={DailyPortrait}
      durationInFrames={300}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ ep: "ep/sample" }}
      calculateMetadata={calcEpisode}
    />
  );
};
