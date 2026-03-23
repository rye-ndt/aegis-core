export const newCurrentUTCEpoch = () => {
  //current utc time, in second
  const now = Date.now();
  return Math.floor(now / 1000);
};
