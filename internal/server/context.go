package server

import "context"

type sessionKey struct{}

func withSession(ctx context.Context, s session) context.Context {
	return context.WithValue(ctx, sessionKey{}, s)
}
func getSession(r interface{ Context() context.Context }) (session, bool) {
	s, ok := r.Context().Value(sessionKey{}).(session)
	return s, ok
}
