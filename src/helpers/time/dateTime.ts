export const newCurrentUTCEpoch = () => {
  //current utc time, in second
  const now = Date.UTC(Date.now());
  return Math.floor(now / 1000);
};
