/** Must run after verifyToken. */
export function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Admin access required" })
  }

  return next()
}