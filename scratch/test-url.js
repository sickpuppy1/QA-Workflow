try {
  const origin = new URL("http://172.16.16.92:6789/billing").origin;
  console.log("Origin:", origin);
  console.log("Match pattern:", origin + "/*");
} catch (e) {
  console.error(e);
}
