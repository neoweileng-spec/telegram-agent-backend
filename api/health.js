// minimal CommonJS serverless function (no deps)
module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('ok ' + new Date().toISOString());
};
