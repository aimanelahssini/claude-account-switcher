#!/usr/bin/env python3
"""A plain window with the given title, standing in for a chat's terminal: window.py TITLE"""
import sys
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk

app = Gtk.Application(application_id=None)
app.connect('activate', lambda a: (lambda w: (w.set_title(sys.argv[1]), w.set_default_size(500, 300), w.present()))(Gtk.ApplicationWindow(application=a)))
app.run([])
